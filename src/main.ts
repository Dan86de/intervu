import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, FileSystem, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { AppConfig, version } from "./AppConfig.ts";
import { ArtifactWatcher } from "./ArtifactWatcher.ts";
import * as Browser from "./Browser.ts";
import { BrowserAssets } from "./BrowserAssets.ts";
import * as ErrorReport from "./ErrorReport.ts";
import { ArtifactNotFound, ConflictingSetupScope } from "./Errors.ts";
import * as IdleShutdown from "./IdleShutdown.ts";
import * as Output from "./Output.ts";
import * as Server from "./Server.ts";
import { ServerLifecycle } from "./ServerLifecycle.ts";
import { SessionHub } from "./SessionHub.ts";
import { SessionPersistence } from "./SessionPersistence.ts";
import { SessionStore } from "./SessionStore.ts";
import { Setup } from "./Setup.ts";
import { SkillAsset } from "./SkillAsset.ts";
import * as Toon from "./Toon.ts";

const bin = "intervu";
const description =
  "Local AXI-style CLI for collaborative review of agent-generated HTML artifacts.";

/**
 * The single emit boundary: every byte intervu writes to stdout passes through
 * here. Success output and the structured-error envelope (ADR 0014) both land
 * here, so stdout has exactly one writer.
 */
const emit = (text: string): Effect.Effect<void> => Console.log(text);

/**
 * Bare `intervu`: the content-first home view (ADR 0013). Reads the `open`
 * Sessions straight from the persisted state file - no daemon, zero network
 * calls - and prints each as `{key, path, status}`. `ended` Sessions are
 * history and omitted; an empty list prints an explicit empty-state help line,
 * distinct from any error.
 */
const root = Command.make(bin, {}, () =>
  Effect.gen(function* () {
    const persistence = yield* SessionPersistence;
    const live = (yield* persistence.load).filter(
      (session) => session.status === "open",
    );

    const view = Output.home({
      bin,
      description,
      sessions: live.map((session) => ({
        key: session.key,
        path: session.path,
        status: session.status,
      })),
      help:
        live.length === 0
          ? "no active reviews - run 'intervu <file>' to open one"
          : "run 'intervu poll <file>' to receive feedback, or 'intervu <file>' to open another",
    });
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
 *
 * `--port <n>` binds *this* process to that port (flag > `INTERVU_PORT` >
 * default); it is the foreground/debug form, so clients still resolve the port
 * via env/default and must set `INTERVU_PORT=<n>` to reach a hand-run instance.
 *
 * Idle self-shutdown (ADR 0016): the served layer is raced against an
 * `IdleShutdown` watcher over the shared `SessionHub` live-connection gauge. The
 * watcher winning interrupts `Layer.launch`, which releases the server scope and
 * runs the same pidfile-cleanup finalizer as a SIGTERM, so a respawned-but-
 * unwatched or cleanly-ended daemon never dangles.
 */
const server = Command.make(
  "server",
  {
    port: Flag.optional(Flag.integer("port")).pipe(
      Flag.withDescription(
        "bind the daemon to this port (default: INTERVU_PORT, else 51789)",
      ),
    ),
  },
  ({ port }) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;
      const hub = yield* SessionHub;
      const boundPort = Option.getOrElse(port, () => config.port);

      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(config.pidFile, `${process.pid}`);

      const serverLayer = Server.layer.pipe(
        Layer.provide(BrowserAssets.layer),
        Layer.provide(
          BunHttpServer.layer({
            hostname: config.hostname,
            port: boundPort,
          }),
        ),
      );

      yield* Effect.ensuring(
        Effect.race(
          Layer.launch(serverLayer),
          IdleShutdown.watch(hub.connectionChanges, config.idleTimeout),
        ),
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
 * `intervu stop`: SIGTERM the daemon via the shared pidfile core
 * (`ServerLifecycle.signalStop`, the same channel takeover uses), which releases
 * the server gracefully. Idempotent (ADR 0014): with no daemon to signal - the
 * pidfile is absent, holds a non-numeric pid, or names a process that is already
 * gone - it is a benign no-op (`stopped: false`, exit 0), so a repeat stop never
 * fails. A genuine read error (e.g. an unreadable pidfile) still propagates.
 */
const stop = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const lifecycle = yield* ServerLifecycle;
    const signalled = yield* lifecycle.signalStop;

    const view = Option.match(signalled, {
      onNone: () => ({
        stopped: false,
        help: "nothing to stop - no daemon is running",
      }),
      onSome: (pid) => ({
        stopped: pid,
        help: "daemon received SIGTERM - it will exit shortly",
      }),
    });
    yield* emit(yield* Toon.encode(view));
  }),
);

/**
 * `intervu setup`: wire intervu into Claude Code. Thin glue over `Setup.install`,
 * which installs both the agent Skill (where Claude Code discovers skills) and a
 * `SessionStart` Hook (merged into the harness settings file so bare `intervu`'s
 * Home view is injected as session-start context, ADR 0013). Each half reports
 * installed-now versus already-present with its resolved location; the result
 * renders as TOON through the single `emit` boundary with a next-step help line.
 * The Skill is carried baked inside the binary (ADR 0007), so this needs no
 * source tree.
 *
 * `--project` scopes both halves to the current project's `.claude` (issue #14)
 * instead of the user-level default, so discovery can be limited to one repo.
 *
 * `--skill-only` / `--hooks-only` restrict setup to exactly one half (issue
 * #15); neither wires both (the default). The two contradict each other, so
 * combining them fails `ConflictingSetupScope` rather than silently dropping a
 * flag. The result reports only the half/halves that were in scope.
 */
const setup = Command.make(
  "setup",
  {
    project: Flag.boolean("project").pipe(
      Flag.withDescription(
        "scope setup to the current project's .claude instead of the user-level default",
      ),
    ),
    skillOnly: Flag.boolean("skill-only").pipe(
      Flag.withDescription("wire only the Skill, leaving the Hook untouched"),
    ),
    hooksOnly: Flag.boolean("hooks-only").pipe(
      Flag.withDescription("wire only the Hook, leaving the Skill untouched"),
    ),
  },
  ({ project, skillOnly, hooksOnly }) =>
    Effect.gen(function* () {
      if (skillOnly && hooksOnly) {
        return yield* Effect.fail(new ConflictingSetupScope({}));
      }
      const scope = skillOnly ? "skill-only" : hooksOnly ? "hook-only" : "both";

      const installer = yield* Setup;
      const result = yield* installer.install({ project, scope });

      const skill = Option.getOrUndefined(result.skill);
      const hook = Option.getOrUndefined(result.hook);
      const changed =
        skill?.action === "installed" || hook?.action === "installed";
      const view = Output.setup({
        skill,
        hook,
        help: changed
          ? "intervu wired up - start a fresh agent session so it discovers the skill and home view, then 'intervu <file>' to open a review"
          : "intervu already wired up - re-running setup changes nothing",
      });
      yield* emit(yield* Toon.encode(view));
    }),
);

const cli = root.pipe(
  Command.withSubcommands([open, poll, end, server, stop, setup]),
);

/**
 * Bare `intervu <file>` aliases `intervu open <file>`. The CLI framework can't
 * mix a root positional argument with subcommands, so an unrecognized leading
 * token that isn't a flag is rewritten to `open <file>` before parsing.
 */
const knownSubcommands = new Set([
  "open",
  "poll",
  "end",
  "server",
  "stop",
  "setup",
]);
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
  Setup.layer,
).pipe(
  Layer.provideMerge(SessionHub.layer),
  Layer.provideMerge(SessionPersistence.fileLayer),
  Layer.provideMerge(SkillAsset.layer),
  Layer.provideMerge(AppConfig.layer),
  Layer.provideMerge(PlatformLayer),
);

/**
 * The structured error contract (ADR 0014), wired onto the `emit` seam:
 *
 * - `tapError` classifies every typed failure that reaches here and prints the
 *   TOON envelope on stdout (or no-ops on framework `CliError`, already
 *   rendered). It preserves the original failure, so the run still exits 1.
 * - `tapDefect` leaves bugs (`die`) raw and loud on stderr via the pretty cause;
 *   they are never masked as a clean structured error.
 *
 * `disableErrorReporting: true` suppresses only the runtime's automatic failure
 * log, so neither tier is double-printed; `defaultTeardown` still computes the
 * exit code (1 on failure, 0 on success).
 */
const program = Command.runWith(cli, { version })(args).pipe(
  Effect.tapError((error) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const view = ErrorReport.report(error, { logFile: config.logFile });
      if (Option.isSome(view)) {
        yield* emit(yield* Toon.encode(view.value));
      }
    }),
  ),
  Effect.tapDefect((defect) => Console.error(Cause.pretty(Cause.die(defect)))),
  Effect.provide(AppLayer),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
