import type { PlatformError } from "effect";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as Context from "effect/Context";
import { AppConfig } from "./AppConfig.ts";
import * as ClaudeSettings from "./ClaudeSettings.ts";
import { CommandResolver } from "./CommandResolver.ts";
import {
  HomeDirectoryUnresolved,
  IntervuNotOnPath,
  SettingsFileUnparseable,
  SettingsFileUnreadable,
} from "./Errors.ts";
import { SkillAsset } from "./SkillAsset.ts";

/**
 * The discovery `setup` operation behind a small `install` interface. It wires
 * both halves of intervu's harness integration under one call: the Skill (write
 * the baked Skill where Claude Code discovers skills) and the Hook (merge a
 * `SessionStart` hook into the harness settings file so bare `intervu`'s Home
 * view is injected as session-start context, ADR 0013). Target resolution, the
 * idempotency checks, and the writes all hide behind `install`; the CLI is thin
 * glue that renders the result as TOON.
 *
 * Location is one knob: `install` defaults to the user-level `<home>/.claude`
 * so discovery is global across projects, and `{ project: true }` retargets both
 * halves to the current project's `<cwd>/.claude` instead. Which halves it wires
 * is a second knob, `scope`: `"both"` (the default), `"skill-only"`, or
 * `"hook-only"` (issue #15) - so a human can wire one half without the other.
 */

/** Whether `install` wrote the artifact now or found it already in place. */
export type InstallAction = "installed" | "already-present";

/** The outcome for one artifact: what happened and the resolved location. */
export interface ArtifactInstall {
  readonly action: InstallAction;
  readonly path: string;
}

/**
 * Which halves `install` wires: both (the default), exactly the Skill, or
 * exactly the Hook. Modelled as a closed sum so the contradictory "wire
 * nothing" state is unrepresentable; the CLI rejects conflicting flags before
 * they ever reach here.
 */
export type InstallScope = "both" | "skill-only" | "hook-only";

/**
 * The structured result `install` returns: one entry per artifact it wires.
 * A half left out of `scope` is absent (`Option.none`), so the report carries
 * only the artifact(s) that were in scope.
 */
export interface SetupResult {
  readonly skill: Option.Option<ArtifactInstall>;
  readonly hook: Option.Option<ArtifactInstall>;
}

/** Where `install` writes and which halves it wires: the user-level default or
 * the current project under `project: true`, scoped to `both` halves or one. */
export interface InstallOptions {
  readonly project: boolean;
  readonly scope: InstallScope;
}

export class Setup extends Context.Service<
  Setup,
  {
    readonly install: (
      options: InstallOptions,
    ) => Effect.Effect<
      SetupResult,
      | IntervuNotOnPath
      | HomeDirectoryUnresolved
      | SettingsFileUnreadable
      | SettingsFileUnparseable
      | PlatformError.PlatformError
    >;
  }
>()("@intervu/Setup") {
  static readonly layer = Layer.effect(
    Setup,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const asset = yield* SkillAsset;
      const resolver = yield* CommandResolver;

      /**
       * Resolve `<claudeDir>/skills/intervu/SKILL.md`, then write the Skill
       * unless it is already byte-identical. An already-present overwrite is a
       * clean no-op in the report; a missing or drifted file is rewritten and
       * reported installed-now.
       */
      const installSkill = (claudeDir: string) =>
        Effect.gen(function* () {
          const skillDir = path.join(claudeDir, "skills", "intervu");
          const skillFile = path.join(skillDir, "SKILL.md");

          const exists = yield* fs.exists(skillFile);
          if (exists) {
            const current = yield* fs.readFileString(skillFile);
            if (current === asset.markdown) {
              return {
                action: "already-present",
                path: skillFile,
              } satisfies ArtifactInstall;
            }
          }

          yield* fs.makeDirectory(skillDir, { recursive: true });
          yield* fs.writeFileString(skillFile, asset.markdown);
          return {
            action: "installed",
            path: skillFile,
          } satisfies ArtifactInstall;
        });

      /**
       * Resolve `<claudeDir>/settings.json`, read-decode-merge-write the
       * `SessionStart` hook. A missing or empty file decodes as empty settings;
       * an unreadable file fails `SettingsFileUnreadable` and a malformed one
       * `SettingsFileUnparseable` rather than being clobbered. The merge is pure
       * and idempotent: an already-present hook is a clean no-op, otherwise the
       * file is rewritten atomically (tmp + rename) so a crash mid-write never
       * corrupts the user's config. Re-encoding a freshly decoded-and-merged
       * value cannot fail in practice, so an encode error is a defect.
       */
      const installHook = (claudeDir: string) =>
        Effect.gen(function* () {
          const settingsFile = path.join(claudeDir, "settings.json");

          const exists = yield* fs.exists(settingsFile);
          const source = exists
            ? yield* fs
                .readFileString(settingsFile)
                .pipe(
                  Effect.mapError(
                    () => new SettingsFileUnreadable({ path: settingsFile }),
                  ),
                )
            : "{}";
          const text = source.trim() === "" ? "{}" : source;

          const settings = yield* Schema.decodeUnknownEffect(
            ClaudeSettings.fromJson,
          )(text).pipe(
            Effect.mapError(
              () => new SettingsFileUnparseable({ path: settingsFile }),
            ),
          );

          const { settings: merged, changed } = ClaudeSettings.mergeHook(
            settings,
            ClaudeSettings.intervuHookCommand,
          );
          if (!changed) {
            return {
              action: "already-present",
              path: settingsFile,
            } satisfies ArtifactInstall;
          }

          const json = yield* ClaudeSettings.toJson(merged).pipe(Effect.orDie);
          yield* fs.makeDirectory(claudeDir, { recursive: true });
          const tmp = `${settingsFile}.tmp`;
          yield* fs.writeFileString(tmp, `${json}\n`);
          yield* fs.rename(tmp, settingsFile);
          return {
            action: "installed",
            path: settingsFile,
          } satisfies ArtifactInstall;
        });

      /**
       * Wire the in-scope half (or both) under one call into the location's
       * `.claude` dir. The user-level default needs a home and fails
       * `HomeDirectoryUnresolved` when there is none - distinct from any no-op;
       * the project location anchors on the always-resolvable cwd, so it never
       * needs a home. A half left out of `scope` is skipped entirely (its
       * effect never runs) and reported absent.
       */
      const install = (options: InstallOptions) =>
        Effect.gen(function* () {
          // Both halves shell out to a bare `intervu` (the Skill tells the agent
          // to run `intervu <file>`; the Hook's command is `intervu`), so wiring
          // them is only meaningful when an `intervu` binary resolves on `PATH`.
          // Refuse up front - before any write - rather than leaving a Skill and
          // Hook that fail the moment they are invoked (ADR 0019). A transient
          // `bunx intervu` never puts `intervu` on `PATH`; a global install does.
          const resolved = yield* resolver.resolve(
            ClaudeSettings.intervuHookCommand,
          );
          if (Option.isNone(resolved)) {
            return yield* Effect.fail(
              new IntervuNotOnPath({
                command: ClaudeSettings.intervuHookCommand,
              }),
            );
          }

          const claudeDir = options.project
            ? path.join(config.currentDir, ".claude")
            : yield* Option.match(config.homeDir, {
                onNone: () => Effect.fail(new HomeDirectoryUnresolved({})),
                onSome: (dir) => Effect.succeed(path.join(dir, ".claude")),
              });
          const skill = yield* installSkill(claudeDir).pipe(
            Effect.when(Effect.succeed(options.scope !== "hook-only")),
          );
          const hook = yield* installHook(claudeDir).pipe(
            Effect.when(Effect.succeed(options.scope !== "skill-only")),
          );
          return { skill, hook } satisfies SetupResult;
        });

      return { install };
    }),
  );
}
