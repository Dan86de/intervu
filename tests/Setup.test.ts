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
const settingsFilePath = `${HOME}/.claude/settings.json`;
const PROJECT = "/work/repo";
const projectSkillFilePath = `${PROJECT}/.claude/skills/intervu/SKILL.md`;
const projectSettingsFilePath = `${PROJECT}/.claude/settings.json`;
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
        rename: (from, to) =>
          Ref.update(ref, (files) => {
            const next = new Map(files);
            const value = next.get(from);
            if (value !== undefined) {
              next.set(to, value);
              next.delete(from);
            }
            return next;
          }),
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
    currentDir: PROJECT,
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

/**
 * Extract a `Some`'s value, failing the test if the artifact was unexpectedly
 * absent (left out of scope). Narrows the `Option` so the value is read without
 * a cast.
 */
const expectSome = <A>(option: Option.Option<A>): A => {
  if (Option.isNone(option)) {
    return expect.unreachable("expected an in-scope artifact, got none");
  }
  return option.value;
};

describe("Setup.install", () => {
  it.effect("a fresh install writes the Skill and reports installed", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const result = yield* setup.install({ project: false, scope: "both" });

      const skill = expectSome(result.skill);
      expect(skill.action).toBe("installed");
      expect(skill.path).toBe(skillFilePath);

      const fs = yield* FileSystem.FileSystem;
      const written = yield* fs.readFileString(skill.path);
      expect(written).toBe(SKILL);
    }).pipe(Effect.provide(setupLayer())),
  );

  it.effect("a fresh install merges the Hook and reports installed", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const result = yield* setup.install({ project: false, scope: "both" });

      const hook = expectSome(result.hook);
      expect(hook.action).toBe("installed");
      expect(hook.path).toBe(settingsFilePath);

      const fs = yield* FileSystem.FileSystem;
      const written = yield* fs.readFileString(hook.path);
      const parsed = JSON.parse(written);
      const commands = parsed.hooks.SessionStart.flatMap(
        (group: { hooks: { command: string }[] }) =>
          group.hooks.map((entry) => entry.command),
      );
      expect(commands).toContain("intervu");
    }).pipe(Effect.provide(setupLayer())),
  );

  it.effect("re-running install is idempotent for both Skill and Hook", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const first = yield* setup.install({ project: false, scope: "both" });
      expect(expectSome(first.skill).action).toBe("installed");
      expect(expectSome(first.hook).action).toBe("installed");

      const second = yield* setup.install({ project: false, scope: "both" });
      const skill = expectSome(second.skill);
      expect(skill.action).toBe("already-present");
      expect(skill.path).toBe(skillFilePath);
      const hook = expectSome(second.hook);
      expect(hook.action).toBe("already-present");
      expect(hook.path).toBe(settingsFilePath);
    }).pipe(Effect.provide(setupLayer())),
  );

  it.effect("merges the Hook into an existing settings file in place", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const result = yield* setup.install({ project: false, scope: "both" });

      const hook = expectSome(result.hook);
      expect(hook.action).toBe("installed");

      const fs = yield* FileSystem.FileSystem;
      const written = yield* fs.readFileString(hook.path);
      const parsed = JSON.parse(written);
      // Unrelated settings survive verbatim.
      expect(parsed.model).toBe("opus");
      const commands = parsed.hooks.SessionStart.flatMap(
        (group: { hooks: { command: string }[] }) =>
          group.hooks.map((entry) => entry.command),
      );
      expect(commands).toContain("intervu");
    }).pipe(
      Effect.provide(setupLayer({ [settingsFilePath]: '{ "model": "opus" }' })),
    ),
  );

  it.effect(
    "refuses an unparseable settings file rather than clobbering it",
    () =>
      Effect.gen(function* () {
        const setup = yield* Setup;
        const error = yield* Effect.flip(
          setup.install({ project: false, scope: "both" }),
        );
        expect(error._tag).toBe("SettingsFileUnparseable");

        // The malformed file is left untouched.
        const fs = yield* FileSystem.FileSystem;
        const after = yield* fs.readFileString(settingsFilePath);
        expect(after).toBe("{ not valid json");
      }).pipe(
        Effect.provide(setupLayer({ [settingsFilePath]: "{ not valid json" })),
      ),
  );

  it.effect("a drifted Skill file is rewritten and reported installed", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const result = yield* setup.install({ project: false, scope: "both" });

      const skill = expectSome(result.skill);
      expect(skill.action).toBe("installed");

      const fs = yield* FileSystem.FileSystem;
      const written = yield* fs.readFileString(skill.path);
      expect(written).toBe(SKILL);
    }).pipe(Effect.provide(setupLayer({ [skillFilePath]: "stale guidance" }))),
  );

  it.effect("fails HomeDirectoryUnresolved when home is unresolved", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const error = yield* Effect.flip(
        setup.install({ project: false, scope: "both" }),
      );
      expect(error._tag).toBe("HomeDirectoryUnresolved");
    }).pipe(Effect.provide(setupLayer({}, Option.none()))),
  );

  it.effect(
    "the project flag targets the project's configuration, not the user's",
    () =>
      Effect.gen(function* () {
        const setup = yield* Setup;
        const result = yield* setup.install({ project: true, scope: "both" });

        expect(expectSome(result.skill).path).toBe(projectSkillFilePath);
        expect(expectSome(result.hook).path).toBe(projectSettingsFilePath);

        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(projectSkillFilePath)).toBe(SKILL);
        const settings = JSON.parse(
          yield* fs.readFileString(projectSettingsFilePath),
        );
        const commands = settings.hooks.SessionStart.flatMap(
          (group: { hooks: { command: string }[] }) =>
            group.hooks.map((entry) => entry.command),
        );
        expect(commands).toContain("intervu");

        // The user-level locations are left untouched.
        expect(yield* fs.exists(skillFilePath)).toBe(false);
        expect(yield* fs.exists(settingsFilePath)).toBe(false);
      }).pipe(Effect.provide(setupLayer())),
  );

  it.effect("the project flag needs no home directory", () =>
    Effect.gen(function* () {
      const setup = yield* Setup;
      const result = yield* setup.install({ project: true, scope: "both" });
      expect(expectSome(result.skill).path).toBe(projectSkillFilePath);
      expect(expectSome(result.hook).path).toBe(projectSettingsFilePath);
    }).pipe(Effect.provide(setupLayer({}, Option.none()))),
  );

  it.effect(
    "skill-only wires exactly the Skill and leaves the Hook alone",
    () =>
      Effect.gen(function* () {
        const setup = yield* Setup;
        const result = yield* setup.install({
          project: false,
          scope: "skill-only",
        });

        const skill = expectSome(result.skill);
        expect(skill.action).toBe("installed");
        expect(skill.path).toBe(skillFilePath);
        expect(Option.isNone(result.hook)).toBe(true);

        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(skillFilePath)).toBe(SKILL);
        // The settings file / Hook is never touched.
        expect(yield* fs.exists(settingsFilePath)).toBe(false);
      }).pipe(Effect.provide(setupLayer())),
  );

  it.effect(
    "hooks-only wires exactly the Hook and leaves the Skill alone",
    () =>
      Effect.gen(function* () {
        const setup = yield* Setup;
        const result = yield* setup.install({
          project: false,
          scope: "hook-only",
        });

        const hook = expectSome(result.hook);
        expect(hook.action).toBe("installed");
        expect(hook.path).toBe(settingsFilePath);
        expect(Option.isNone(result.skill)).toBe(true);

        const fs = yield* FileSystem.FileSystem;
        const settings = JSON.parse(yield* fs.readFileString(settingsFilePath));
        const commands = settings.hooks.SessionStart.flatMap(
          (group: { hooks: { command: string }[] }) =>
            group.hooks.map((entry) => entry.command),
        );
        expect(commands).toContain("intervu");
        // The Skill file is never written.
        expect(yield* fs.exists(skillFilePath)).toBe(false);
      }).pipe(Effect.provide(setupLayer())),
  );
});
