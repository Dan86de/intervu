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
  StaleDaemon,
  StaleServerTakeover,
} from "./Errors.ts";
import { EndResponse, Health, PollResponse } from "./Protocol.ts";
import { Session } from "./Session.ts";

type EnsureError =
  | ServerStartTimeout
  | StaleServerTakeover
  | PlatformError.PlatformError
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

/**
 * Parse a `major.minor.patch` string into a numeric tuple, or `None` when it is
 * not three dot-separated integers (ADR 0015). Pre-release / build suffixes are
 * not modelled - the version is a controlled `0.0.0`-shaped string.
 */
const parseVersion = (
  version: string,
): Option.Option<readonly [number, number, number]> => {
  const parts = version.split(".");
  if (parts.length !== 3) {
    return Option.none();
  }
  const [major, minor, patch] = parts.map((part) => Number.parseInt(part, 10));
  return major !== undefined &&
    minor !== undefined &&
    patch !== undefined &&
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch)
    ? Option.some([major, minor, patch] as const)
    : Option.none();
};

/**
 * The takeover predicate (ADR 0015): is the running daemon strictly older than
 * this client? Compares the two versions as numeric `major.minor.patch` tuples;
 * an unparseable *running* version counts as stale (take over), while an
 * unparseable *client* version never evicts (defensive - our own version is the
 * controlled `0.0.0`-shaped string). Equal-or-newer is reused, so only a
 * strictly-newer client ever replaces a server.
 */
export const isStaleVersion = (
  runningVersion: string,
  clientVersion: string,
): boolean => {
  const running = parseVersion(runningVersion);
  if (Option.isNone(running)) {
    return true;
  }
  const client = parseVersion(clientVersion);
  if (Option.isNone(client)) {
    return false;
  }
  const [rMajor, rMinor, rPatch] = running.value;
  const [cMajor, cMinor, cPatch] = client.value;
  if (rMajor !== cMajor) {
    return rMajor < cMajor;
  }
  if (rMinor !== cMinor) {
    return rMinor < cMinor;
  }
  return rPatch < cPatch;
};

type PollError =
  | ReviewNotOpen
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

type EndError =
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
      | DaemonNotRunning
      | StaleDaemon
      | HttpClientError.HttpClientError
      | Schema.SchemaError
    >;
    readonly signalStop: Effect.Effect<
      Option.Option<number>,
      PlatformError.PlatformError
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
    readonly end: (path: string) => Effect.Effect<EndResponse, EndError>;
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

      // Read the shared `server.pid` and SIGTERM the daemon, the one channel
      // that works across the version gap (ADR 0015): every version writes the
      // pidfile and dies gracefully on the signal. Returns the signalled pid, or
      // `None` when there is nothing to stop - the pidfile is absent, holds a
      // non-numeric pid, or names a process that is already gone (`process.kill`
      // throws, treated as the benign no-op). Shared by `intervu stop` and
      // takeover; a genuine pidfile read error still propagates.
      const signalStop: Effect.Effect<
        Option.Option<number>,
        PlatformError.PlatformError
      > = Effect.gen(function* () {
        const exists = yield* fs.exists(config.pidFile);
        if (!exists) {
          return Option.none();
        }
        const pidText = yield* fs.readFileString(config.pidFile);
        const pid = Number.parseInt(pidText.trim(), 10);
        if (Number.isNaN(pid)) {
          return Option.none();
        }
        const signalled = yield* Effect.try(() =>
          process.kill(pid, "SIGTERM"),
        ).pipe(Effect.orElseSucceed(() => false));
        return signalled ? Option.some(pid) : Option.none();
      });

      // Probe whether the port is free: a `/health` answer (or any non-refused
      // error) means the old daemon is still bound; a connection-refused means
      // it is gone.
      const probePortFree: Effect.Effect<boolean> = ping.pipe(
        Effect.as(false),
        Effect.catch((error) => Effect.succeed(isConnRefused(error))),
      );

      // After SIGTERM, wait for the stale daemon to release the port, capped at
      // ~5s. If it will not exit in that window the takeover cannot proceed.
      const waitPortFree = probePortFree.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (free) => free,
        }),
        Effect.timeout("5 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new StaleServerTakeover({
              port: config.port,
              reason:
                "the stale daemon did not exit within the takeover window",
            }),
          ),
        ),
      );

      // Evict a strictly-older daemon and spawn our own (ADR 0015): signal via
      // the pidfile, wait for the port to free, then spawn and wait healthy. A
      // missing/garbage pidfile (nothing to signal) means the old daemon is
      // orphaned on the port and the client refuses to spawn into it.
      const takeover = Effect.gen(function* () {
        const signalled = yield* signalStop;
        if (Option.isNone(signalled)) {
          return yield* Effect.fail(
            new StaleServerTakeover({
              port: config.port,
              reason:
                "a stale daemon holds the port but its pidfile is missing or invalid",
            }),
          );
        }
        yield* waitPortFree;
        yield* spawnDaemon;
        return yield* waitHealthy;
      });

      // The `open` path (ADR 0015): spawn when nothing answers, otherwise reuse
      // a healthy equal-or-newer daemon and take over a strictly-older one. The
      // conn-refused catch sits on `ping` so it narrows the original infra-error
      // union; the version check follows, and a freshly spawned daemon is our own
      // version, so it is never seen as stale.
      const ensure = ping.pipe(
        Effect.catch((error) =>
          isConnRefused(error)
            ? spawnDaemon.pipe(Effect.flatMap(() => waitHealthy))
            : Effect.fail(error),
        ),
        Effect.flatMap((health) =>
          isStaleVersion(health.version, config.version)
            ? takeover
            : Effect.succeed(health),
        ),
      );

      // The poll/end path: a healthy daemon must already exist - these never
      // spawn one (ADR 0009), so a refused connection is a definitive
      // `DaemonNotRunning`. The same version predicate runs, but a strictly-older
      // daemon is a refuse-and-redirect `StaleDaemon` (re-run `intervu <file>` to
      // take over) rather than an inline takeover on the long-poll hot path.
      const requireHealthy = ping.pipe(
        Effect.mapError((error) =>
          isConnRefused(error) ? new DaemonNotRunning() : error,
        ),
        Effect.flatMap((health) =>
          isStaleVersion(health.version, config.version)
            ? Effect.fail(new StaleDaemon())
            : Effect.succeed(health),
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

      // End from the terminal (ADR 0011): the agent-facing thin client over
      // `POST /end`. Path-addressed and lookup-without-create, so a `404` is a
      // structured `ReviewNotOpen` - the daemon is up but nothing is open here.
      const end = (path: string) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(`${baseUrl}/end`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ path }),
          );
          const response = yield* client.execute(request);
          if (response.status === 404) {
            return yield* new ReviewNotOpen({ path });
          }
          return yield* HttpClientResponse.schemaBodyJson(EndResponse)(
            response,
          );
        });

      return {
        ensure,
        requireHealthy,
        signalStop,
        openSession,
        poll,
        end,
      };
    }),
  );
}
