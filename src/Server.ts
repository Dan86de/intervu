import {
  Duration,
  Effect,
  FileSystem,
  Filter,
  Layer,
  Option,
  Path,
  Stream,
} from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { AppConfig } from "./AppConfig.ts";
import * as ArtifactAssets from "./ArtifactAssets.ts";
import { ArtifactWatcher } from "./ArtifactWatcher.ts";
import { BrowserAssets } from "./BrowserAssets.ts";
import * as FeedbackWait from "./FeedbackWait.ts";
import {
  OpenSessionRequest,
  PollRequest,
  PollResponse,
  ValidFeedback,
} from "./Protocol.ts";
import { type Session, SessionKey } from "./Session.ts";
import {
  ConversationAppended,
  FeedbackQueued,
  SessionHub,
} from "./SessionHub.ts";
import { SessionStore } from "./SessionStore.ts";
import * as Sse from "./Sse.ts";

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
 *
 * A Send also appends the human's message to the Conversation and publishes a
 * `ConversationAppended` (ADR 0010), so the chrome renders it from the SSE
 * stream rather than an optimistic local insert. The two events are distinct:
 * `FeedbackQueued` stays payload-free (the poll's wake-signal; ADR 0009) and the
 * thread frame carries the entry. `annotationCount` lets the chrome render an
 * annotation-only Feedback (empty message) as a count, not a blank bubble.
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
      const entry = yield* store.appendConversation(session.key, {
        role: "human",
        text: feedback.message,
        annotationCount: feedback.annotations.length,
      });
      yield* hub.publish(session.key, new ConversationAppended({ entry }));
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
 *
 * A non-blank `agentReply` is posted into the Conversation (ADR 0010) before the
 * wait begins, so the reply reaches the chrome over the SSE stream immediately -
 * not on this response, which stays held open for minutes. A blank or absent
 * reply is a no-op and just polls.
 */
const pollRoute = HttpRouter.add(
  "POST",
  "/poll",
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const hub = yield* SessionHub;
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
          Effect.gen(function* () {
            const reply = request.agentReply?.trim() ?? "";
            if (reply.length > 0) {
              const entry = yield* store.appendConversation(open.key, {
                role: "agent",
                text: reply,
                annotationCount: 0,
              });
              yield* hub.publish(open.key, new ConversationAppended({ entry }));
            }
            const outcome = yield* FeedbackWait.wait(open.key, {
              timeout: Option.map(
                Option.fromNullishOr(request.timeoutSeconds),
                Duration.seconds,
              ),
            });
            return yield* HttpServerResponse.schemaJson(PollResponse)(
              new PollResponse({
                timedOut: outcome.timedOut,
                feedback: outcome.feedback,
              }),
            );
          }),
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

/** The `: ping` heartbeat cadence on the SSE stream (ADR 0010 insurance). */
const SSE_PING_INTERVAL = Duration.seconds(20);

/**
 * The single server-to-browser SSE channel (ADR 0010): one `text/event-stream`
 * response multiplexing live-reload, Conversation appends, and Presence. On
 * connect it replays the Conversation newer than `Last-Event-ID` plus the current
 * Presence, then streams live hub frames merged with a `: ping` heartbeat;
 * `FeedbackQueued` is filtered out so the poll's wake-signal never reaches the
 * browser. The hub subscription and the watcher ref-count ride the body stream's
 * scope (`Stream.unwrap` manages it), released when `BunHttpServer` interrupts
 * the handler on client disconnect - the same abort wiring as the poll (ADR
 * 0009). The handler's context is captured and re-provided to the body, which the
 * server runs after the handler returns.
 */
const eventsRoute = HttpRouter.add(
  "GET",
  "/s/:key/events",
  withSession((session) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<
        SessionHub | SessionStore | ArtifactWatcher
      >();
      const request = yield* HttpServerRequest.HttpServerRequest;
      const afterSeq = Sse.parseLastEventId(request.headers["last-event-id"]);

      const body = Stream.unwrap(
        Effect.gen(function* () {
          const hub = yield* SessionHub;
          const store = yield* SessionStore;
          const watcher = yield* ArtifactWatcher;
          const subscription = yield* hub.subscribe(session.key);
          yield* watcher.track(session.key, session.path);

          const replay = yield* store.conversationSince(session.key, afterSeq);
          const presence = yield* hub.presence(session.key);
          const initial = Stream.fromIterable([
            ...replay.map(Sse.conversationFrame),
            Sse.presenceFrame(presence),
          ]);
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filterMap(Filter.fromPredicateOption(Sse.liveFrame)),
          );
          const heartbeat = Stream.tick(SSE_PING_INTERVAL).pipe(
            Stream.map(() => Sse.PING_FRAME),
          );
          return Stream.concat(initial, Stream.merge(live, heartbeat));
        }),
      ).pipe(Stream.encodeText, Stream.provideContext(services));

      return HttpServerResponse.stream(body, {
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      });
    }),
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
    eventsRoute,
    sdkRoute,
    chromeScriptRoute,
    chromeStyleRoute,
  ),
);
