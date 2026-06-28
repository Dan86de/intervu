import { openSync } from "node:fs";
import {
  Effect,
  FileSystem,
  Layer,
  type PlatformError,
  Schedule,
  type Schema,
} from "effect";
import * as Context from "effect/Context";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { AppConfig } from "./AppConfig.ts";
import { ServerStartTimeout } from "./Errors.ts";
import { Health } from "./Protocol.ts";
import { Session } from "./Session.ts";

type EnsureError =
  | ServerStartTimeout
  | PlatformError.PlatformError
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

/**
 * The CLI's view of the daemon (ADR 0002): the CLI is a thin HTTP client that
 * ensures a healthy daemon exists - self-spawning `intervu server` detached when
 * absent - then opens or resumes a Session over HTTP. State lives entirely in the
 * daemon; this service never touches `SessionStore`.
 */
export class ServerLifecycle extends Context.Service<
  ServerLifecycle,
  {
    readonly ensure: Effect.Effect<Health, EnsureError>;
    readonly openSession: (
      path: string,
    ) => Effect.Effect<
      Session,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
  }
>()("@intervu/ServerLifecycle") {
  static readonly layer = Layer.effect(
    ServerLifecycle,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;
      const baseUrl = `http://${config.hostname}:${config.port}`;

      const ping = client
        .execute(HttpClientRequest.get(`${baseUrl}/health`))
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)));

      const isConnRefused = (
        error: HttpClientError.HttpClientError | Schema.SchemaError,
      ) =>
        HttpClientError.isHttpClientError(error) &&
        error.reason._tag === "TransportError";

      // Self-spawn `intervu server` detached, redirecting its output to the log
      // file. `unref` lets this CLI exit without waiting on the daemon.
      const spawnDaemon = Effect.gen(function* () {
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* Effect.sync(() => {
          const fd = openSync(config.logFile, "a");
          const child = Bun.spawn(
            [process.execPath, process.argv[1] ?? "", "server"],
            {
              env: process.env,
              stdin: "ignore",
              stdout: fd,
              stderr: fd,
            },
          );
          child.unref();
        });
      });

      // Poll health until the freshly spawned daemon binds, capped at ~5s.
      const waitHealthy = ping.pipe(
        Effect.retry({
          while: isConnRefused,
          schedule: Schedule.spaced("100 millis"),
        }),
        Effect.timeout("5 seconds"),
        Effect.catchTag(
          "TimeoutError",
          () => new ServerStartTimeout({ port: config.port }),
        ),
      );

      const ensure = ping.pipe(
        Effect.catch((error) =>
          isConnRefused(error)
            ? spawnDaemon.pipe(Effect.flatMap(() => waitHealthy))
            : Effect.fail(error),
        ),
      );

      const openSession = (path: string) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(`${baseUrl}/sessions`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ path }),
          );
          const response = yield* client.execute(request);
          return yield* HttpClientResponse.schemaBodyJson(Session)(response);
        });

      return { ensure, openSession };
    }),
  );
}
