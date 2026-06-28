import { Duration, Effect, FileSystem, Layer, Option, Path } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { AppConfig } from "./AppConfig.ts";
import * as ArtifactAssets from "./ArtifactAssets.ts";
import { BrowserAssets } from "./BrowserAssets.ts";
import * as FeedbackWait from "./FeedbackWait.ts";
import {
  OpenSessionRequest,
  PollRequest,
  PollResponse,
  ValidFeedback,
} from "./Protocol.ts";
import { type Session, SessionKey } from "./Session.ts";
import { FeedbackQueued, SessionHub } from "./SessionHub.ts";
import { SessionStore } from "./SessionStore.ts";

/**
 * The daemon's HTTP surface (issues #3, #4). Routes are total - each handler
 * maps its own failures to a response so the served layer carries no
 * request-scoped error markers. The browser-opened URL is the stable `/s/:key`;
 * it now serves the chrome (top bar + conversation panel) wrapping the artifact,
 * which renders in a sandboxed opaque-origin iframe at `/s/:key/a/` (ADR 0003).
 */

const notFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status: 404 });

/**
 * Resolve the `:key` route param to its Session, replying with a uniform `404`
 * for an unknown (or missing) key. The continuation is total: it maps its own
 * IO failures to a response, so the route never leaks an error into the layer.
 */
const withSession = <R>(
  use: (
    session: Session,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
) =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const params = yield* HttpRouter.params;
    const rawKey = params.key;
    if (rawKey === undefined) {
      return notFound();
    }
    const session = yield* store.get(SessionKey.make(rawKey));
    return yield* Option.match(session, {
      onNone: () => Effect.succeed(notFound()),
      onSome: use,
    });
  });

const healthRoute = HttpRouter.add(
  "GET",
  "/health",
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return HttpServerResponse.jsonUnsafe({ ok: true, version: config.version });
  }),
);

const sessionsRoute = HttpRouter.add(
  "POST",
  "/sessions",
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const body = yield* HttpServerRequest.schemaBodyJson(OpenSessionRequest);
    const session = yield* store.open(body.path);
    return HttpServerResponse.jsonUnsafe({
      key: session.key,
      path: session.path,
      status: session.status,
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("POST /sessions failed", error).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  ),
);

/** The stable opened URL: the chrome page wrapping the artifact's iframe. */
const chromeRoute = HttpRouter.add(
  "GET",
  "/s/:key",
  withSession((session) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const html = ArtifactAssets.renderChrome({
        key: session.key,
        filename: path.basename(session.path),
        path: session.path,
      });
      return HttpServerResponse.text(html, { contentType: "text/html" });
    }),
  ),
);

/**
 * The shared artifact-and-assets prefix. `HttpRouter` registers a `/*` route at
 * both `/s/:key/a/*` and `/s/:key/a`, so the iframe `src` `/s/:key/a/` lands
 * here with an empty remainder and serves the artifact HTML (SDK injected); a
 * non-empty remainder resolves a sibling asset, confined to the artifact
 * directory by the pure path-safety check. A rejection and a missing asset both
 * return `404`, so a response never reveals whether an out-of-directory path
 * exists.
 */
const artifactRoute = HttpRouter.add(
  "GET",
  "/s/:key/a/*",
  withSession((session) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const params = yield* HttpRouter.params;
      const remainder = params["*"] ?? "";

      if (remainder === "") {
        return yield* fs.readFileString(session.path).pipe(
          Effect.map((html) =>
            HttpServerResponse.text(ArtifactAssets.injectSdk(html), {
              contentType: "text/html",
            }),
          ),
          Effect.catch((error) =>
            Effect.logError("GET /s/:key/a/ read failed", error).pipe(
              Effect.as(HttpServerResponse.empty({ status: 500 })),
            ),
          ),
        );
      }

      const dir = path.dirname(session.path);
      const resolution = ArtifactAssets.resolveAsset(path, dir, remainder);
      if (resolution._tag === "Rejected") {
        return notFound();
      }
      return yield* fs.readFile(resolution.path).pipe(
        Effect.map((bytes) =>
          HttpServerResponse.uint8Array(bytes, {
            contentType: ArtifactAssets.contentTypeFor(path, resolution.path),
          }),
        ),
        Effect.catch((error) =>
          Effect.logDebug("GET /s/:key/a/* asset read failed", error).pipe(
            Effect.as(notFound()),
          ),
        ),
      );
    }),
  ),
);

/** The artifact's raw, un-injected bytes - the "copy DOM snapshot" source. */
const sourceRoute = HttpRouter.add(
  "GET",
  "/s/:key/source",
  withSession((session) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(session.path).pipe(
        Effect.map((html) =>
          HttpServerResponse.text(html, { contentType: "text/html" }),
        ),
        Effect.catch((error) =>
          Effect.logError("GET /s/:key/source read failed", error).pipe(
            Effect.as(HttpServerResponse.empty({ status: 500 })),
          ),
        ),
      );
    }),
  ),
);

/**
 * The chrome's Send target: queue one Feedback for the Session and signal any
 * waiting poll. The body is re-validated against `ValidFeedback` (non-empty
 * message or >=1 annotation), so a malformed or empty submission is a `400` and
 * the queue never holds an empty Feedback. `queueFeedback` then `publish` order
 * is load-bearing: a poll that subscribed first sees the signal and drains.
 */
const feedbackRoute = HttpRouter.add(
  "POST",
  "/s/:key/feedback",
  withSession((session) =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const hub = yield* SessionHub;
      const feedback = yield* HttpServerRequest.schemaBodyJson(ValidFeedback);
      yield* store.queueFeedback(session.key, feedback);
      yield* hub.publish(session.key, new FeedbackQueued());
      return HttpServerResponse.jsonUnsafe({ queued: true });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("POST /s/:key/feedback rejected", error).pipe(
          Effect.as(HttpServerResponse.empty({ status: 400 })),
        ),
      ),
    ),
  ),
);

/**
 * The agent's long-poll (ADR 0009): path-addressed and lookup-without-create, so
 * an unopened path is a structured `404` (`ReviewNotOpen`) rather than a silent
 * spawn. For an open Session it holds the request, draining queued Feedback once
 * the human sends (or returning the `timedOut` marker when the request set a
 * bound). `Effect.scoped` ties the hub subscription to the request: a killed
 * poll interrupts this fiber and releases it.
 */
const pollRoute = HttpRouter.add(
  "POST",
  "/poll",
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const request = yield* HttpServerRequest.schemaBodyJson(PollRequest);
    const session = yield* store.getByPath(request.path);
    return yield* Option.match(session, {
      onNone: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { _tag: "ReviewNotOpen", path: request.path },
            { status: 404 },
          ),
        ),
      onSome: (open) =>
        Effect.scoped(
          FeedbackWait.wait(open.key, {
            timeout: Option.map(
              Option.fromNullishOr(request.timeoutSeconds),
              Duration.seconds,
            ),
          }).pipe(
            Effect.flatMap((outcome) =>
              HttpServerResponse.schemaJson(PollResponse)(
                new PollResponse({
                  timedOut: outcome.timedOut,
                  feedback: outcome.feedback,
                }),
              ),
            ),
          ),
        ),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("POST /poll failed", error).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  ),
);

/**
 * The global in-iframe SDK, injected into every artifact, plus the chrome's own
 * controller and stylesheet. All three are built from `src/sdk` + `src/chrome`
 * and served from `BrowserAssets` (ADR 0007); the routes are stable, only the
 * served bytes vary between the dev build and the baked bundle.
 */
const sdkRoute = HttpRouter.add(
  "GET",
  "/sdk.js",
  Effect.gen(function* () {
    const assets = yield* BrowserAssets;
    return HttpServerResponse.text(assets.sdkJs, {
      contentType: "text/javascript",
    });
  }),
);

const chromeScriptRoute = HttpRouter.add(
  "GET",
  "/chrome.js",
  Effect.gen(function* () {
    const assets = yield* BrowserAssets;
    return HttpServerResponse.text(assets.chromeJs, {
      contentType: "text/javascript",
    });
  }),
);

const chromeStyleRoute = HttpRouter.add(
  "GET",
  "/chrome.css",
  Effect.gen(function* () {
    const assets = yield* BrowserAssets;
    return HttpServerResponse.text(assets.chromeCss, {
      contentType: "text/css",
    });
  }),
);

/**
 * The served HTTP app layer. Requires the actual `HttpServer` (bound by
 * `BunHttpServer.layer`) plus the route dependencies, all supplied by the
 * daemon's layer composition.
 */
export const layer = HttpRouter.serve(
  Layer.mergeAll(
    healthRoute,
    sessionsRoute,
    chromeRoute,
    artifactRoute,
    sourceRoute,
    feedbackRoute,
    pollRoute,
    sdkRoute,
    chromeScriptRoute,
    chromeStyleRoute,
  ),
);
