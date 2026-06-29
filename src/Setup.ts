import type { PlatformError } from "effect";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as Context from "effect/Context";
import { AppConfig } from "./AppConfig.ts";
import { HomeDirectoryUnresolved } from "./Errors.ts";
import { SkillAsset } from "./SkillAsset.ts";

/**
 * The discovery `setup` operation behind a small `install` interface. This slice
 * (#12) does the Skill half: resolve the user-level target Claude Code discovers
 * skills in, write the baked Skill there, and report what it did. Target
 * resolution, the existence/idempotency check, and the write all hide behind
 * `install`; the CLI is thin glue that renders the result as TOON. The hook half
 * (settings merge) is added later under the same interface.
 */

/** Whether `install` wrote the artifact now or found it already in place. */
export type InstallAction = "installed" | "already-present";

/** The outcome for the Skill: what happened and the resolved location. */
export interface SkillInstall {
  readonly action: InstallAction;
  readonly path: string;
}

/** The structured result `install` returns; gains a `hook` field in a later slice. */
export interface SetupResult {
  readonly skill: SkillInstall;
}

export class Setup extends Context.Service<
  Setup,
  {
    readonly install: Effect.Effect<
      SetupResult,
      HomeDirectoryUnresolved | PlatformError.PlatformError
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
       * reported installed-now. Fails `HomeDirectoryUnresolved` when there is no
       * home to install into - distinct from any no-op.
       */
      const install = Effect.gen(function* () {
        const home = yield* Option.match(config.homeDir, {
          onNone: () => Effect.fail(new HomeDirectoryUnresolved({})),
          onSome: (dir) => Effect.succeed(dir),
        });
        const skillDir = path.join(home, ".claude", "skills", "intervu");
        const skillFile = path.join(skillDir, "SKILL.md");

        const exists = yield* fs.exists(skillFile);
        if (exists) {
          const current = yield* fs.readFileString(skillFile);
          if (current === asset.markdown) {
            return {
              skill: { action: "already-present", path: skillFile },
            } satisfies SetupResult;
          }
        }

        yield* fs.makeDirectory(skillDir, { recursive: true });
        yield* fs.writeFileString(skillFile, asset.markdown);
        return {
          skill: { action: "installed", path: skillFile },
        } satisfies SetupResult;
      });

      return { install };
    }),
  );
}
