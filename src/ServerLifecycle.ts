import { openSync } from "node:fs";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
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
import {
  DaemonNotRunning,
  ReviewNotOpen,
  ServerStartTimeout,
} from "./Errors.ts";
import { Health, PollResponse } from "./Protocol.ts";
import { Session } from "./Session.ts";

type EnsureError =
  | ServerStartTimeout
  | PlatformError.PlatformError
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

type PollError =
  | ReviewNotOpen
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
    readonly requireHealthy: Effect.Effect<
      Health,
      DaemonNotRunning | HttpClientError.HttpClientError | Schema.SchemaError
    >;
    readonly openSession: (
      path: string,
    ) => Effect.Effect<
      Session,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    readonly poll: (
      path: string,
      timeoutSeconds: Option.Option<number>,
      agentReply: Option.Option<string>,
    ) => Effect.Effect<PollResponse, PollError>;
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

      // The poll path: a healthy daemon must already exist - `poll` never spawns
      // one (ADR 0009), so a refused connection is a definitive `DaemonNotRunning`.
      const requireHealthy = ping.pipe(
        Effect.mapError((error) =>
          isConnRefused(error) ? new DaemonNotRunning() : error,
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

      // Long-poll: hold a single request open until the daemon returns the
      // drained Feedback (or the `timedOut` marker). A `404` means nothing is
      // open at this path - a structured `ReviewNotOpen`, not feedback. The
      // request carries no response timeout, so an indefinite block is not
      // severed client-side.
      const poll = (
        path: string,
        timeoutSeconds: Option.Option<number>,
        agentReply: Option.Option<string>,
      ) =>
        Effect.gen(function* () {
          const withTimeout = Option.match(timeoutSeconds, {
            onNone: () => ({ path }),
            onSome: (seconds) => ({ path, timeoutSeconds: seconds }),
          });
          const body = Option.match(agentReply, {
            onNone: () => withTimeout,
            onSome: (reply) => ({ ...withTimeout, agentReply: reply }),
          });
          const request = HttpClientRequest.post(`${baseUrl}/poll`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          );
          const response = yield* client.execute(request);
          if (response.status === 404) {
            return yield* new ReviewNotOpen({ path });
          }
          return yield* HttpClientResponse.schemaBodyJson(PollResponse)(
            response,
          );
        });

      return { ensure, requireHealthy, openSession, poll };
    }),
  );
}
