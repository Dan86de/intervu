import { Effect, FileSystem, Layer, Option } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { AppConfig } from "./AppConfig.ts";
import { OpenSessionRequest } from "./Protocol.ts";
import { SessionKey } from "./Session.ts";
import { SessionStore } from "./SessionStore.ts";

/**
 * The daemon's HTTP surface (issue #3). Routes are total - each handler maps its
 * own failures to a response so the served layer carries no request-scoped error
 * markers. The browser-opened URL is the stable `/s/:key`; the chrome + iframe
 * split (#10) adds a sub-route without changing it.
 */

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

const artifactRoute = HttpRouter.add(
  "GET",
  "/s/:key",
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const fs = yield* FileSystem.FileSystem;
    const params = yield* HttpRouter.params;
    const rawKey = params.key;
    if (rawKey === undefined) {
      return HttpServerResponse.empty({ status: 404 });
    }
    const session = yield* store.get(SessionKey.make(rawKey));
    return yield* Option.match(session, {
      onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      onSome: (found) =>
        fs.readFileString(found.path).pipe(
          Effect.map((html) =>
            HttpServerResponse.text(html, { contentType: "text/html" }),
          ),
          Effect.catch((error) =>
            Effect.logError("GET /s/:key read failed", error).pipe(
              Effect.as(HttpServerResponse.empty({ status: 500 })),
            ),
          ),
        ),
    });
  }),
);

/**
 * The served HTTP app layer. Requires the actual `HttpServer` (bound by
 * `BunHttpServer.layer`) plus the route dependencies, all supplied by the
 * daemon's layer composition.
 */
export const layer = HttpRouter.serve(
  Layer.mergeAll(healthRoute, sessionsRoute, artifactRoute),
);
