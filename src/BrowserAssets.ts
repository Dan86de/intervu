import { Effect, FileSystem, Layer } from "effect";
import * as Context from "effect/Context";
import { BrowserAssetBuildError } from "./Errors.ts";
import {
  bakedChromeCss,
  bakedChromeJs,
  bakedSdkJs,
} from "./generated/browserAssets.ts";

/**
 * The three browser assets the daemon serves: the in-iframe SDK (`/sdk.js`), the
 * chrome controller (`/chrome.js`), and the chrome stylesheet (`/chrome.css`).
 *
 * They are authored as real TypeScript / Tailwind under `src/sdk` + `src/chrome`
 * and built two ways (ADR 0007): the shipped single-file binary serves the baked
 * bundle that `scripts/build-browser.ts` froze into `generated/browserAssets.ts`
 * before `main.ts` was bundled; running from source, the daemon rebuilds on
 * start so an edit is live on the next restart. The dev build uses `Bun.build`
 * and the Tailwind CLI, which exist only under the Bun runtime - tests provide
 * `bakedLayer`, never `layer`, so they never invoke a build.
 */

const sdkEntry = `${import.meta.dir}/sdk/entry.ts`;
const chromeEntry = `${import.meta.dir}/chrome/entry.ts`;
const cssEntry = `${import.meta.dir}/chrome/styles.css`;
const repoRoot = `${import.meta.dir}/..`;
const tailwindCli = `${repoRoot}/node_modules/@tailwindcss/cli/dist/index.mjs`;

export interface BrowserAssetBundle {
  readonly sdkJs: string;
  readonly chromeJs: string;
  readonly chromeCss: string;
}

type BuildResult =
  | { readonly ok: true; readonly bundle: BrowserAssetBundle }
  | { readonly ok: false; readonly reason: string };

const bundleEntry = async (entry: string): Promise<string | null> => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!result.success) {
    return null;
  }
  const output = result.outputs[0];
  return output === undefined ? null : output.text();
};

const compileCss = async (): Promise<string | null> => {
  const proc = Bun.spawn(["bun", tailwindCli, "-i", cssEntry, "--minify"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const css = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return code === 0 ? css : null;
};

/**
 * Build the three assets from `src/sdk` + `src/chrome`: `Bun.build` bundles the
 * SDK and chrome controller as self-running IIFEs (so a classic `<script src>`
 * runs them), and the Tailwind v4 CLI compiles the stylesheet. Returns a
 * discriminated result rather than throwing, so each caller surfaces a failure
 * in its own idiom - the daemon's dev layer as a typed Effect failure, the bake
 * script as a non-zero exit.
 */
export const buildBrowserAssetsFromSource = async (): Promise<BuildResult> => {
  try {
    const sdkJs = await bundleEntry(sdkEntry);
    if (sdkJs === null) {
      return { ok: false, reason: `failed to bundle ${sdkEntry}` };
    }
    const chromeJs = await bundleEntry(chromeEntry);
    if (chromeJs === null) {
      return { ok: false, reason: `failed to bundle ${chromeEntry}` };
    }
    const chromeCss = await compileCss();
    if (chromeCss === null) {
      return { ok: false, reason: `failed to compile ${cssEntry}` };
    }
    return { ok: true, bundle: { sdkJs, chromeJs, chromeCss } };
  } catch (cause) {
    return { ok: false, reason: String(cause) };
  }
};

const bakedBundle: BrowserAssetBundle = {
  sdkJs: bakedSdkJs,
  chromeJs: bakedChromeJs,
  chromeCss: bakedChromeCss,
};

export class BrowserAssets extends Context.Service<
  BrowserAssets,
  BrowserAssetBundle
>()("@intervu/BrowserAssets") {
  /** The assets frozen by `scripts/build-browser.ts`; what the shipped
   * single-file binary serves, with no source tree to build from. */
  static readonly bakedLayer = Layer.succeed(BrowserAssets, bakedBundle);

  /**
   * Dev rebuilds from source on daemon start; the shipped binary (no source
   * tree) falls back to the baked bundle. The branch is the presence of the SDK
   * entry next to this module, so no env flag is needed.
   */
  static readonly layer = Layer.effect(
    BrowserAssets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fromSource = yield* fs.exists(sdkEntry);
      if (!fromSource) {
        return bakedBundle;
      }
      const result = yield* Effect.promise(() =>
        buildBrowserAssetsFromSource(),
      );
      if (!result.ok) {
        return yield* new BrowserAssetBuildError({ reason: result.reason });
      }
      return result.bundle;
    }),
  );
}
