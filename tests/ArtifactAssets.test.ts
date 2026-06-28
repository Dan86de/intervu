import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";
import * as ArtifactAssets from "../src/ArtifactAssets.ts";

/**
 * ArtifactAssets is pure: the path-safety resolver and content-type derivation
 * run against a real `Path.Path` (from `BunPath`) with no filesystem touched,
 * and the chrome/SDK string transforms need no services at all.
 */

const dir = "/proj/artifact";

describe("ArtifactAssets.resolveAsset", () => {
  it.effect(
    "confines a nested relative asset under the artifact directory",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolution = ArtifactAssets.resolveAsset(
          path,
          dir,
          "assets/img/logo.png",
        );
        expect(resolution).toEqual({
          _tag: "Confined",
          path: "/proj/artifact/assets/img/logo.png",
        });
      }).pipe(Effect.provide(BunPath.layer)),
  );

  it.effect("rejects a parent-directory escape", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolution = ArtifactAssets.resolveAsset(
        path,
        dir,
        "../secret.txt",
      );
      expect(resolution._tag).toBe("Rejected");
    }).pipe(Effect.provide(BunPath.layer)),
  );

  it.effect("rejects an absolute path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolution = ArtifactAssets.resolveAsset(path, dir, "/etc/passwd");
      expect(resolution._tag).toBe("Rejected");
    }).pipe(Effect.provide(BunPath.layer)),
  );

  it.effect("rejects an empty remainder", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolution = ArtifactAssets.resolveAsset(path, dir, "");
      expect(resolution._tag).toBe("Rejected");
    }).pipe(Effect.provide(BunPath.layer)),
  );
});

describe("ArtifactAssets.contentTypeFor", () => {
  it.effect("derives the content type from the file extension", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(ArtifactAssets.contentTypeFor(path, "/a/style.css")).toBe(
        "text/css",
      );
      expect(ArtifactAssets.contentTypeFor(path, "/a/logo.png")).toBe(
        "image/png",
      );
      expect(ArtifactAssets.contentTypeFor(path, "/a/data.bin")).toBe(
        "application/octet-stream",
      );
      expect(ArtifactAssets.contentTypeFor(path, "/a/noext")).toBe(
        "application/octet-stream",
      );
    }).pipe(Effect.provide(BunPath.layer)),
  );
});

describe("ArtifactAssets.injectSdk", () => {
  it("injects the SDK script before the closing body tag", () => {
    const injected = ArtifactAssets.injectSdk(
      "<html><body><h1>Hi</h1></body></html>",
    );
    expect(injected).toBe(
      '<html><body><h1>Hi</h1><script src="/sdk.js"></script></body></html>',
    );
  });

  it("injects before the last closing body tag, case-insensitively", () => {
    const injected = ArtifactAssets.injectSdk("<BODY>x</BODY>");
    expect(injected).toBe('<BODY>x<script src="/sdk.js"></script></BODY>');
  });

  it("appends the SDK script when there is no body tag", () => {
    const injected = ArtifactAssets.injectSdk("<h1>Hi</h1>");
    expect(injected).toBe('<h1>Hi</h1><script src="/sdk.js"></script>');
  });
});

describe("ArtifactAssets.renderChrome", () => {
  const chrome = ArtifactAssets.renderChrome({
    key: "abc123def4567890",
    filename: "report.html",
    path: "/proj/artifact/report.html",
  });

  it("embeds the filename and points the iframe at the artifact route", () => {
    expect(chrome).toContain("report.html");
    expect(chrome).toContain('src="/s/abc123def4567890/a/"');
  });

  it("sandboxes the iframe to an opaque origin", () => {
    expect(chrome).toContain(
      'sandbox="allow-scripts allow-forms allow-popups"',
    );
    expect(chrome).not.toContain("allow-same-origin");
    expect(chrome).not.toContain("allow-top-navigation");
  });

  it("wires the copy controls and relabels the source control", () => {
    expect(chrome).toContain("data-copy-path");
    expect(chrome).toContain("data-copy-source");
    expect(chrome).toContain(">Copy source<");
    expect(chrome).toContain("/s/abc123def4567890/source");
    // The "Copy DOM snapshot" label is freed for the live-DOM term (ADR 0008).
    expect(chrome).not.toContain("data-copy-snapshot");
    expect(chrome).not.toContain("Copy DOM snapshot");
  });

  it("renders the composer with a gated Send control", () => {
    expect(chrome).toContain("data-composer");
    expect(chrome).toContain("data-composer-input");
    expect(chrome).toContain("<textarea");
    expect(chrome).toContain("data-send");
    expect(chrome).toContain(">Send to Agent<");
    // Send starts disabled until the submit rule passes.
    expect(chrome).toContain("data-send disabled");
  });

  it("links the build-time chrome stylesheet and controller", () => {
    expect(chrome).toContain('<link rel="stylesheet" href="/chrome.css" />');
    expect(chrome).toContain('<script src="/chrome.js"></script>');
    // Styling is the built Tailwind output, not inline CSS.
    expect(chrome).not.toContain("<style");
  });

  it("renders the Annotate-mode toggle, initially off", () => {
    expect(chrome).toContain("data-annotate-toggle");
    expect(chrome).toContain('aria-pressed="false"');
    expect(chrome).toContain(">Annotate<");
    expect(chrome).toContain("bg-background");
  });

  it("marks the artifact iframe for the controller and shows the pending panel", () => {
    expect(chrome).toContain("data-artifact");
    expect(chrome).toContain("Pending annotations");
    expect(chrome).toContain("data-pending-list");
  });

  it("embeds the session config the controller reads back", () => {
    const match = chrome.match(
      /<script type="application\/json" id="intervu-config">([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    const config: unknown = JSON.parse(match?.[1] ?? "");
    expect(config).toEqual({
      path: "/proj/artifact/report.html",
      sourceUrl: "/s/abc123def4567890/source",
      key: "abc123def4567890",
    });
  });
});
