import type { PlatformError } from "effect";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as Context from "effect/Context";
import { AppConfig } from "./AppConfig.ts";
import * as ClaudeSettings from "./ClaudeSettings.ts";
import {
  HomeDirectoryUnresolved,
  SettingsFileUnparseable,
  SettingsFileUnreadable,
} from "./Errors.ts";
import { SkillAsset } from "./SkillAsset.ts";

/**
 * The discovery `setup` operation behind a small `install` interface. It wires
 * both halves of intervu's harness integration under one call: the Skill (write
 * the baked Skill to the user-level location Claude Code discovers skills in)
 * and the Hook (merge a `SessionStart` hook into the harness settings file so
 * bare `intervu`'s Home view is injected as session-start context, ADR 0013).
 * Target resolution, the idempotency checks, and the writes all hide behind
 * `install`; the CLI is thin glue that renders the result as TOON.
 */

/** Whether `install` wrote the artifact now or found it already in place. */
export type InstallAction = "installed" | "already-present";

/** The outcome for one artifact: what happened and the resolved location. */
export interface ArtifactInstall {
  readonly action: InstallAction;
  readonly path: string;
}

/** The structured result `install` returns: one entry per artifact it wires. */
export interface SetupResult {
  readonly skill: ArtifactInstall;
  readonly hook: ArtifactInstall;
}

export class Setup extends Context.Service<
  Setup,
  {
    readonly install: Effect.Effect<
      SetupResult,
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

      /**
       * Resolve `<home>/.claude/skills/intervu/SKILL.md`, then write the Skill
       * unless it is already byte-identical. An already-present overwrite is a
       * clean no-op in the report; a missing or drifted file is rewritten and
       * reported installed-now.
       */
      const installSkill = (home: string) =>
        Effect.gen(function* () {
          const skillDir = path.join(home, ".claude", "skills", "intervu");
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
       * Resolve `<home>/.claude/settings.json`, read-decode-merge-write the
       * `SessionStart` hook. A missing or empty file decodes as empty settings;
       * an unreadable file fails `SettingsFileUnreadable` and a malformed one
       * `SettingsFileUnparseable` rather than being clobbered. The merge is pure
       * and idempotent: an already-present hook is a clean no-op, otherwise the
       * file is rewritten atomically (tmp + rename) so a crash mid-write never
       * corrupts the user's config. Re-encoding a freshly decoded-and-merged
       * value cannot fail in practice, so an encode error is a defect.
       */
      const installHook = (home: string) =>
        Effect.gen(function* () {
          const claudeDir = path.join(home, ".claude");
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
       * Wire both halves under one call. Fails `HomeDirectoryUnresolved` when
       * there is no home to install into - distinct from any no-op.
       */
      const install = Effect.gen(function* () {
        const home = yield* Option.match(config.homeDir, {
          onNone: () => Effect.fail(new HomeDirectoryUnresolved({})),
          onSome: (dir) => Effect.succeed(dir),
        });
        const skill = yield* installSkill(home);
        const hook = yield* installHook(home);
        return { skill, hook } satisfies SetupResult;
      });

      return { install };
    }),
  );
}
