import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { AppConfig, version } from "./AppConfig.ts";
import { ArtifactWatcher } from "./ArtifactWatcher.ts";
import * as Browser from "./Browser.ts";
import { BrowserAssets } from "./BrowserAssets.ts";
import { ArtifactNotFound, DaemonNotRunning } from "./Errors.ts";
import * as Output from "./Output.ts";
import * as Server from "./Server.ts";
import { ServerLifecycle } from "./ServerLifecycle.ts";
import { SessionHub } from "./SessionHub.ts";
import { SessionPersistence } from "./SessionPersistence.ts";
import { SessionStore } from "./SessionStore.ts";
import * as Toon from "./Toon.ts";

const bin = "intervu";
const description =
  "Local AXI-style CLI for collaborative review of agent-generated HTML artifacts.";
const help = "run 'intervu <artifact.html>' to open a review session";

/**
 * The single emit boundary: every byte intervu writes to stdout passes through
 * here. It is success-only for now; slice #9 hooks structured-error formatting
 * onto this seam.
 */
const emit = (text: string): Effect.Effect<void> => Console.log(text);

/**
 * Bare `intervu`: the content-first home view. `SessionStore` lives in the
 * daemon, so listing live Sessions over HTTP is held for a later slice; this
 * keeps the static empty-sessions stub from #2.
 */
const root = Command.make(bin, {}, () =>
  Effect.gen(function* () {
    const view = Output.home({ bin, description, sessions: [], help });
    yield* emit(yield* Toon.encode(view));
  }),
);

/**
 * `intervu open <file>` (and the bare-file alias): resolve the artifact's
 * realpath, ensure the daemon is up, open or resume the Session, pop a browser
 * tab at `/s/:key`, and print the Session as TOON.
 */
const open = Command.make("open", { file: Argument.file("file") }, ({ file }) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const fs = yield* FileSystem.FileSystem;
    const lifecycle = yield* ServerLifecycle;

    const realPath = yield* fs
      .realPath(file)
      .pipe(Effect.mapError(() => new ArtifactNotFound({ path: file })));

    yield* lifecycle.ensure;
    const session = yield* lifecycle.openSession(realPath);

    const url = `http://${config.hostname}:${config.port}/s/${session.key}`;
    yield* Browser.openTab(url);

    const view = Output.session({
      key: session.key,
      path: session.path,
      status: session.status,
      help: `review open - run 'intervu poll ${file}' to receive feedback`,
    });
    yield* emit(yield* Toon.encode(view));
  }),
);

/**
 * `intervu poll <file>` (ADR 0009): the agent's long-poll. Resolve the
 * artifact's realpath, require an already-running daemon (no spawn), then hold a
 * single request open until the human sends - printing the drained Feedback as
 * TOON. `--timeout <seconds>` bounds the wait and prints `timedOut: true`
 * instead. `--agent-reply "<message>"` posts that message into the human's
 * conversation panel before waiting again (ADR 0010), so the agent can explain
 * what it changed and keep listening. Killing and re-running is safe: queued
 * Feedback survives.
 */
const poll = Command.make(
  "poll",
  {
    file: Argument.file("file"),
    timeout: Flag.optional(Flag.integer("timeout")).pipe(
      Flag.withDescription(
        "seconds to wait before returning timedOut (default: wait indefinitely)",
      ),
    ),
    agentReply: Flag.optional(Flag.string("agent-reply")).pipe(
      Flag.withDescription(
        "post this message into the conversation panel before waiting again",
      ),
    ),
  },
  ({ file, timeout, agentReply }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lifecycle = yield* ServerLifecycle;

      const realPath = yield* fs
        .realPath(file)
        .pipe(Effect.mapError(() => new ArtifactNotFound({ path: file })));

      yield* lifecycle.requireHealthy;
      const response = yield* lifecycle.poll(realPath, timeout, agentReply);

      const view = response.timedOut
        ? Output.pollTimedOut({
            help: `no feedback within the timeout - run 'intervu poll ${file}' to keep listening`,
          })
        : response.ended
          ? Output.pollEnded({
              feedback: response.feedback,
              help: `review ended - apply any final feedback above, then stop; re-run 'intervu ${file}' to reopen`,
            })
          : Output.pollFeedback({
              feedback: response.feedback,
              help: `feedback received - edit the artifact, then 'intervu poll ${file}' to listen again`,
            });
      yield* emit(yield* Toon.encode(view));
    }),
);

/**
 * `intervu end <file>` (ADR 0011): the agent-facing end. Resolve the artifact's
 * realpath, require an already-running daemon (no spawn, mirroring `poll`), then
 * end the Session over `POST /end` and print the confirmation as TOON. No
 * final-feedback rider - that is the chrome's Send & end. Re-running
 * `intervu <file>` resurrects the path to a live review (ADR 0012).
 */
const end = Command.make("end", { file: Argument.file("file") }, ({ file }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lifecycle = yield* ServerLifecycle;

    const realPath = yield* fs
      .realPath(file)
      .pipe(Effect.mapError(() => new ArtifactNotFound({ path: file })));

    yield* lifecycle.requireHealthy;
    yield* lifecycle.end(realPath);

    const view = Output.ended({
      help: `review ended - re-run 'intervu ${file}' to reopen`,
    });
    yield* emit(yield* Toon.encode(view));
  }),
);

/**
 * `intervu server`: the foreground daemon. Binds the loopback port, writes the
 * pidfile, serves the routes, and stops gracefully on SIGTERM - `runMain` turns
 * the signal into fiber interruption that runs the pidfile-cleanup finalizer.
 */
const server = Command.make("server", {}, () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const fs = yield* FileSystem.FileSystem;

    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(config.pidFile, `${process.pid}`);

    const serverLayer = Server.layer.pipe(
      Layer.provide(BrowserAssets.layer),
      Layer.provide(
        BunHttpServer.layer({
          hostname: config.hostname,
          port: config.port,
        }),
      ),
    );

    yield* Effect.ensuring(
      Layer.launch(serverLayer),
      fs
        .remove(config.pidFile, { force: true })
        .pipe(
          Effect.catch((error) =>
            Effect.logError("failed to remove pidfile", error),
          ),
        ),
    );
  }),
);

/**
 * `intervu stop`: read the pidfile and SIGTERM the daemon, which releases the
 * server gracefully.
 */
const stop = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const fs = yield* FileSystem.FileSystem;

    const pidText = yield* fs
      .readFileString(config.pidFile)
      .pipe(Effect.mapError(() => new DaemonNotRunning()));
    const pid = Number.parseInt(pidText.trim(), 10);
    if (Number.isNaN(pid)) {
      return yield* new DaemonNotRunning();
    }

    yield* Effect.try({
      try: () => process.kill(pid, "SIGTERM"),
      catch: () => new DaemonNotRunning(),
    });

    yield* emit(
      yield* Toon.encode({ stopped: pid, help: "daemon received SIGTERM" }),
    );
  }),
);

const cli = root.pipe(Command.withSubcommands([open, poll, end, server, stop]));

/**
 * Bare `intervu <file>` aliases `intervu open <file>`. The CLI framework can't
 * mix a root positional argument with subcommands, so an unrecognized leading
 * token that isn't a flag is rewritten to `open <file>` before parsing.
 */
const knownSubcommands = new Set(["open", "poll", "end", "server", "stop"]);
const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0];
const args =
  firstArg !== undefined &&
  !firstArg.startsWith("-") &&
  !knownSubcommands.has(firstArg)
    ? ["open", ...rawArgs]
    : rawArgs;

const PlatformLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

// `SessionHub` is provided once and re-exported, so the daemon's routes,
// `FeedbackWait`, and the `ArtifactWatcher` all share the one hub instance - a
// second hub would split publishes from subscribers.
const AppLayer = Layer.mergeAll(
  SessionStore.layer,
  ServerLifecycle.layer,
  ArtifactWatcher.layer,
).pipe(
  Layer.provideMerge(SessionHub.layer),
  Layer.provideMerge(SessionPersistence.fileLayer),
  Layer.provideMerge(AppConfig.layer),
  Layer.provideMerge(PlatformLayer),
);

const program = Command.runWith(cli, { version })(args).pipe(
  Effect.provide(AppLayer),
);

BunRuntime.runMain(program);
