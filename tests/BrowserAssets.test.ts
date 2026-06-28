import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BrowserAssets } from "../src/BrowserAssets.ts";

/**
 * BrowserAssets is exercised through its baked layer, which surfaces the strings
 * `scripts/build-browser.ts` froze into `generated/browserAssets.ts`. The dev
 * `layer` rebuilds from source with `Bun.build` + the Tailwind CLI, which run
 * only under the Bun runtime - never under vitest - so tests use `bakedLayer`.
 */
describe("BrowserAssets.bakedLayer", () => {
  it.effect("exposes the built SDK, chrome controller, and stylesheet", () =>
    Effect.gen(function* () {
      const assets = yield* BrowserAssets;
      expect(typeof assets.sdkJs).toBe("string");
      expect(typeof assets.chromeJs).toBe("string");
      expect(typeof assets.chromeCss).toBe("string");
      // The bake produced real bundles: both scripts carry the Bridge namespace,
      // and the stylesheet is the Tailwind v4 build (its banner comment).
      expect(assets.sdkJs).toContain("intervu/bridge/v1");
      expect(assets.chromeJs).toContain("intervu/bridge/v1");
      expect(assets.chromeCss).toContain("tailwindcss");
    }).pipe(Effect.provide(BrowserAssets.bakedLayer)),
  );
});
