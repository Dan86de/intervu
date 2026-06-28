import type { Path } from "effect/Path";

/**
 * Pure artifact-presentation helpers for the daemon's HTTP surface (issue #4).
 *
 * The daemon serves one artifact wrapped in intervu's chrome: a slim top bar
 * plus a conversation panel around the artifact's sandboxed iframe. This module
 * owns the three pure transforms behind that surface - rendering the chrome,
 * injecting the in-iframe SDK, and the path-traversal-safe asset resolver - kept
 * free of effects and IO so they are deterministic and unit testable, exactly
 * like `Output`. The server module yields `Path.Path`/`FileSystem` and feeds
 * these functions; nothing here touches the filesystem.
 */

/**
 * Outcome of resolving a sibling-asset request against the artifact directory.
 * `Confined` carries an absolute path proven to stay under the directory;
 * `Rejected` is the uniform answer for every unsafe input, so a response never
 * reveals whether an out-of-directory path exists.
 */
export type AssetResolution =
  | { readonly _tag: "Confined"; readonly path: string }
  | { readonly _tag: "Rejected" };

const confined = (path: string): AssetResolution => ({
  _tag: "Confined",
  path,
});

const rejected: AssetResolution = { _tag: "Rejected" };

/**
 * Pure, lexical path-safety check confining a request to the artifact directory
 * (ADR 0003 / issue #4). Rejects empty, NUL-bearing, and absolute inputs, then
 * `path.resolve`s to collapse any `..` and requires the result stays under
 * `dir`. No filesystem is touched, so a symlink inside `dir` pointing out is the
 * accepted residual risk; the daemon is loopback-only. The wildcard remainder
 * arrives already URL-decoded from the router, so this does not decode again.
 */
export const resolveAsset = (
  path: Path,
  dir: string,
  request: string,
): AssetResolution => {
  if (
    request === "" ||
    request.includes("\u0000") ||
    path.isAbsolute(request)
  ) {
    return rejected;
  }
  const resolved = path.resolve(dir, request);
  const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  return resolved === dir || resolved.startsWith(prefix)
    ? confined(resolved)
    : rejected;
};

const mimeTypes: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain",
  xml: "application/xml",
  pdf: "application/pdf",
  wasm: "application/wasm",
  map: "application/json",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/**
 * Derive a response Content-Type from a file extension, falling back to
 * `application/octet-stream` for unknown or extension-less names.
 */
export const contentTypeFor = (path: Path, filePath: string): string => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension.length <= 1) {
    return "application/octet-stream";
  }
  return mimeTypes[extension.slice(1)] ?? "application/octet-stream";
};

const sdkScriptTag = '<script src="/sdk.js"></script>';

/**
 * Inject the in-iframe SDK before the artifact's closing `</body>` (matched
 * case-insensitively on the last occurrence), appending it when the artifact has
 * no body tag. The injection wiring is stable; the annotation slice swaps only
 * the served `/sdk.js` contents, not this seam.
 */
export const injectSdk = (html: string): string => {
  const index = html.toLowerCase().lastIndexOf("</body>");
  if (index === -1) {
    return `${html}${sdkScriptTag}`;
  }
  return `${html.slice(0, index)}${sdkScriptTag}${html.slice(index)}`;
};

/**
 * The placeholder served at `/sdk.js`. The annotation slice replaces the file
 * contents with the built in-iframe SDK bundle; the injection mechanism above
 * stays untouched.
 */
export const sdkPlaceholder = `// intervu in-iframe SDK (placeholder).
// The annotation slice replaces this file with the built bundle that captures
// the human's clicks and text selections inside the artifact and bridges them
// to the chrome via postMessage. It derives its session from location.pathname.
`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Encode a string for safe embedding inside an inline `<script>` body. */
const jsonForScript = (value: string): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

const chromeStyles = `
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #1a1a1f;
    background: #ffffff;
    display: flex;
    flex-direction: column;
  }
  .bar {
    flex: none;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    border-bottom: 1px solid #e2e2e6;
    background: #fafafa;
  }
  .brand { font-weight: 600; font-size: 13px; letter-spacing: 0.02em; }
  .filename {
    font-size: 13px;
    color: #6b6b76;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .actions { margin-left: auto; display: flex; gap: 8px; }
  .actions button {
    font: inherit;
    font-size: 12px;
    padding: 5px 10px;
    border: 1px solid #e2e2e6;
    border-radius: 6px;
    background: #ffffff;
    color: #1a1a1f;
    cursor: pointer;
  }
  .actions button:hover { background: #f2f2f4; }
  .actions button:disabled { cursor: default; opacity: 0.7; }
  .stage { flex: 1; display: flex; min-height: 0; }
  .artifact { flex: 1; width: 100%; height: 100%; border: none; background: #ffffff; }
  .conversation {
    flex: none;
    width: 320px;
    padding: 16px;
    border-left: 1px solid #e2e2e6;
    background: #fcfcfd;
    overflow-y: auto;
  }
  .conversation-title {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b6b76;
  }
  .empty { margin: 0; font-size: 13px; line-height: 1.5; color: #6b6b76; }
`;

const chromeScript = (pathJson: string, sourceJson: string): string => `
  (() => {
    const artifactPath = ${pathJson};
    const sourceUrl = ${sourceJson};
    const flash = (button, label) => {
      const original = button.dataset.label;
      button.textContent = label;
      button.disabled = true;
      window.setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1200);
    };
    const wire = (selector, run) => {
      const button = document.querySelector(selector);
      if (button === null) return;
      button.dataset.label = button.textContent;
      button.addEventListener("click", () => { run(button); });
    };
    wire("[data-copy-path]", async (button) => {
      try {
        await navigator.clipboard.writeText(artifactPath);
        flash(button, "Copied");
      } catch {
        flash(button, "Copy failed");
      }
    });
    wire("[data-copy-snapshot]", async (button) => {
      try {
        const response = await fetch(sourceUrl);
        const source = await response.text();
        await navigator.clipboard.writeText(source);
        flash(button, "Copied");
      } catch {
        flash(button, "Copy failed");
      }
    });
  })();
`;

/** Pre-shaped inputs for the chrome page, like `Output`'s view shapers. */
export interface ChromeParams {
  readonly key: string;
  readonly filename: string;
  readonly path: string;
}

/**
 * Render the chrome page for a session: a slim top bar (filename plus the two
 * working copy controls) and a presentational conversation panel wrapping the
 * artifact's sandboxed, opaque-origin iframe (ADR 0003). This is an honest shell
 * - no message input, Send, presence, or end control until their slices make
 * them functional. The iframe `src` is `/s/:key/a/`, so the artifact's relative
 * URLs resolve under that prefix with no `<base>` tag and no URL rewriting.
 */
export const renderChrome = (params: ChromeParams): string => {
  const safeFilename = escapeHtml(params.filename);
  const iframeSrc = `/s/${params.key}/a/`;
  const sourceUrl = `/s/${params.key}/source`;
  const script = chromeScript(
    jsonForScript(params.path),
    jsonForScript(sourceUrl),
  );
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>intervu - ${safeFilename}</title>
    <style>${chromeStyles}</style>
  </head>
  <body>
    <header class="bar">
      <span class="brand">intervu</span>
      <span class="filename" title="${escapeHtml(params.path)}">${safeFilename}</span>
      <div class="actions">
        <button type="button" data-copy-path>Copy path</button>
        <button type="button" data-copy-snapshot>Copy DOM snapshot</button>
      </div>
    </header>
    <main class="stage">
      <iframe
        class="artifact"
        src="${iframeSrc}"
        title="${safeFilename}"
        sandbox="allow-scripts allow-forms allow-popups"
      ></iframe>
      <aside class="conversation">
        <h2 class="conversation-title">Conversation</h2>
        <p class="empty">No feedback yet. Annotations and the review loop arrive in a later slice.</p>
      </aside>
    </main>
    <script>${script}</script>
  </body>
</html>
`;
};
