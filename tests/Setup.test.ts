import { describe, expect, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Ref,
} from "effect";
import { AppConfig } from "../src/AppConfig.ts";
import { Setup } from "../src/Setup.ts";
import { SkillAsset } from "../src/SkillAsset.ts";

/**
 * Setup exercised against an in-memory FileSystem layer (no real files touched),
 * the same in-memory-layer-at-the-edge pattern SessionStore uses: a `Ref<Map>`
 * stands in for the filesystem, with `Path` (posix) and a stub `AppConfig`
 * providing the home directory. `seed` pre-populates the in-memory files.
 */

const HOME = "/home/test";
const skillFilePath = `${HOME}/.claude/skills/intervu/SKILL.md`;
const SKILL = "# intervu\nopen / poll / --agent-reply / end\n";

const memoryFsLayer = (seed: Record<string, string> = {}) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const ref = yield* Ref.make(
        new Map<string, string>(Object.entries(seed)),
      );
      return FileSystem.makeNoop({
        exists: (path) => Effect.map(Ref.get(ref), (files) => files.has(path)),
        readFileString: (path) =>
          Effect.flatMap(Ref.get(ref), (files) => {
            const value = files.get(path);
            return value === undefined
              ? Effect.fail(
                  PlatformError.badArgument({
                    module: "FileSystem",
                    method: "readFileString",
                    description: `no such file: ${path}`,
                  }),
                )
              : Effect.succeed(value);
          }),
        writeFileString: (path, data) =>
          Ref.update(ref, (files) => new Map(files).set(path, data)),
        makeDirectory: () => Effect.void,
      });
    }),
  );

const testConfig = (homeDir: Option.Option<string>) =>
  Layer.succeed(AppConfig, {
    version: "0.0.0",
    hostname: "127.0.0.1",
    port: 51789,
    idleTimeout: Duration.seconds(30),
    stateDir: "/state",
    stateFile: "/state/state.json",
    pidFile: "/state/server.pid",
    logFile: "/state/server.log",
    homeDir,
  });

const setupLayer = (
  seed: Record<string, string> = {},
  home: Option.Option<string> = Option.some(HOME),
) =>
  Setup.layer.pipe(
    Layer.provideMerge(memoryFsLayer(seed)),
    Layer.provide(Path.layer),
    Layer.provide(Layer.succeed(SkillAsset, { markdown: SKILL })),
    Layer.provide(testConfig(home)),
  );

describe("Setup.install", () => {
  it.effect("a fresh install writes the Skill and reports installed", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const result = yield* setup.install;

      expect(result.skill.action).toBe("installed");
      expect(result.skill.path).toBe(skillFilePath);

      const fs = yield* FileSystem.FileSystem;
      const written = yield* fs.readFileString(result.skill.path);
      expect(written).toBe(SKILL);
    }).pipe(Effect.provide(setupLayer())),
  );

  it.effect(
    "re-running install is idempotent and reports already-present",
    () =>
      Effect.gen(function* () {
        const setup = yield* Setup;
        const first = yield* setup.install;
        expect(first.skill.action).toBe("installed");

        const second = yield* setup.install;
        expect(second.skill.action).toBe("already-present");
        expect(second.skill.path).toBe(skillFilePath);
      }).pipe(Effect.provide(setupLayer())),
  );

  it.effect("a drifted Skill file is rewritten and reported installed", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const result = yield* setup.install;

      expect(result.skill.action).toBe("installed");

      const fs = yield* FileSystem.FileSystem;
      const written = yield* fs.readFileString(result.skill.path);
      expect(written).toBe(SKILL);
    }).pipe(Effect.provide(setupLayer({ [skillFilePath]: "stale guidance" }))),
  );

  it.effect("fails HomeDirectoryUnresolved when home is unresolved", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const error = yield* Effect.flip(setup.install);
      expect(error._tag).toBe("HomeDirectoryUnresolved");
    }).pipe(Effect.provide(setupLayer({}, Option.none()))),
  );
});
