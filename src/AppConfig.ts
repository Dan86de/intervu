import { Config, Duration, Effect, Layer, Option, Path, Schema } from "effect";
import * as Context from "effect/Context";

/** The version reported by `GET /health` and `intervu --version`. */
export const version = "0.0.0";

/** Default loopback port; `INTERVU_PORT` overrides. */
const defaultPort = 51789;

/** Default idle-shutdown grace in seconds; `INTERVU_IDLE_TIMEOUT` overrides. */
const defaultIdleSeconds = 30;

const Port = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
);

const IdleSeconds = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
);

/**
 * Resolved runtime configuration shared by the CLI client and the daemon: the
 * loopback bind target and the per-user state directory with its derived file
 * paths. State dir resolves `$INTERVU_STATE_DIR` -> `$XDG_STATE_HOME/intervu` ->
 * `~/.local/state/intervu` (ADR 0002), the same shape on macOS and Linux.
 */
export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly version: string;
    readonly hostname: string;
    readonly port: number;
    readonly idleTimeout: Duration.Duration;
    readonly stateDir: string;
    readonly stateFile: string;
    readonly pidFile: string;
    readonly logFile: string;
    readonly homeDir: Option.Option<string>;
  }
>()("@intervu/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const port = yield* Config.schema(Port, "INTERVU_PORT").pipe(
        Config.orElse(() => Config.succeed(defaultPort)),
      );
      const idleSeconds = yield* Config.schema(
        IdleSeconds,
        "INTERVU_IDLE_TIMEOUT",
      ).pipe(Config.orElse(() => Config.succeed(defaultIdleSeconds)));
      const override = yield* Config.option(Config.string("INTERVU_STATE_DIR"));
      const xdg = yield* Config.option(Config.string("XDG_STATE_HOME"));
      // An unset or empty `HOME` is unresolved: it falls back to "" for the
      // state-dir derivation but stays `None` for `homeDir`, so `setup` can fail
      // `HomeDirectoryUnresolved` rather than installing under a bare root.
      const homeDir = (yield* Config.option(Config.string("HOME"))).pipe(
        Option.filter((value) => value.length > 0),
      );
      const home = Option.getOrElse(homeDir, () => "");

      const stateDir = Option.match(override, {
        onSome: (dir) => dir,
        onNone: () =>
          Option.match(xdg, {
            onSome: (base) => path.join(base, "intervu"),
            onNone: () => path.join(home, ".local", "state", "intervu"),
          }),
      });

      return {
        version,
        hostname: "127.0.0.1",
        port,
        idleTimeout: Duration.seconds(idleSeconds),
        stateDir,
        stateFile: path.join(stateDir, "state.json"),
        pidFile: path.join(stateDir, "server.pid"),
        logFile: path.join(stateDir, "server.log"),
        homeDir,
      };
    }),
  );
}
