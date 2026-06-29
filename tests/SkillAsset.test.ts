import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SkillAsset } from "../src/SkillAsset.ts";

/**
 * SkillAsset is exercised through its baked layer, which surfaces the markdown
 * `scripts/build-skill.ts` froze into `generated/skillAsset.ts`. The dev `layer`
 * reads `SKILL.md` from source, which exists only when running from a source
 * tree - never under vitest - so tests use `bakedLayer`.
 *
 * The content invariant guards the shipped guidance: the baked Skill must carry
 * the loop's key commands, so it can never silently drift to empty or omit a step.
 */
describe("SkillAsset.bakedLayer", () => {
  it.effect("bakes the review-loop Skill carrying its key commands", () =>
    Effect.gen(function* () {
      const asset = yield* SkillAsset;
      expect(typeof asset.markdown).toBe("string");
      expect(asset.markdown.length).toBeGreaterThan(0);
      expect(asset.markdown).toContain("open");
      expect(asset.markdown).toContain("poll");
      expect(asset.markdown).toContain("--agent-reply");
      expect(asset.markdown).toContain("end");
    }).pipe(Effect.provide(SkillAsset.bakedLayer)),
  );
});
