import { Effect, FileSystem, Layer } from "effect";
import * as Context from "effect/Context";
import { bakedSkillMarkdown } from "./generated/skillAsset.ts";

/**
 * intervu's agent Skill: the canonical markdown that describes the review loop,
 * which `intervu setup` writes to the user-level location Claude Code discovers
 * skills in.
 *
 * It is authored as real markdown under `src/skill/SKILL.md` and carried two
 * ways (ADR 0007), the same shape as `BrowserAssets`: the shipped single-file
 * binary serves the baked string that `scripts/build-skill.ts` froze into
 * `generated/skillAsset.ts` before `main.ts` was bundled; running from source,
 * the dev `layer` reads `SKILL.md` directly so an edit is live on the next run.
 * Tests provide `bakedLayer`, never `layer`, so they never touch the filesystem.
 */

const skillSource = `${import.meta.dir}/skill/SKILL.md`;

export interface SkillAssetShape {
  readonly markdown: string;
}

const bakedAsset: SkillAssetShape = { markdown: bakedSkillMarkdown };

export class SkillAsset extends Context.Service<SkillAsset, SkillAssetShape>()(
  "@intervu/SkillAsset",
) {
  /** The markdown frozen by `scripts/build-skill.ts`; what the shipped
   * single-file binary writes out, with no source tree to read from. */
  static readonly bakedLayer = Layer.succeed(SkillAsset, bakedAsset);

  /**
   * Dev reads `SKILL.md` from source on each run; the shipped binary (no source
   * tree) falls back to the baked string. The branch is the presence of the
   * source file next to this module, so no env flag is needed.
   */
  static readonly layer = Layer.effect(
    SkillAsset,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fromSource = yield* fs.exists(skillSource);
      if (!fromSource) {
        return bakedAsset;
      }
      const markdown = yield* fs.readFileString(skillSource);
      return { markdown };
    }),
  );
}
