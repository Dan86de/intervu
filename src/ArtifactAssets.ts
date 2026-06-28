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
 * no body tag. The injection wiring is stable; `/sdk.js` now serves the built
 * SDK bundle (`BrowserAssets`), but this seam is unchanged.
 */
export const injectSdk = (html: string): string => {
  const index = html.toLowerCase().lastIndexOf("</body>");
  if (index === -1) {
    return `${html}${sdkScriptTag}`;
  }
  return `${html.slice(0, index)}${sdkScriptTag}${html.slice(index)}`;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * JSON-encode a value for safe embedding inside an inline element, escaping the
 * characters that could break out of the `<script>` block or the HTML parser.
 * `JSON.parse` reverses the `\uXXXX` escapes, so the controller reads it back
 * unchanged.
 */
const jsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

/** Pre-shaped inputs for the chrome page, like `Output`'s view shapers. */
export interface ChromeParams {
  readonly key: string;
  readonly filename: string;
  readonly path: string;
}

/** The shared button utilities; the Annotate toggle adds its pressed-state
 * variants on top. Authored statically so the build-time Tailwind scan captures
 * every class (ADR 0004). */
const buttonClass =
  "cursor-pointer rounded-md border border-border bg-background px-2.5 py-[5px] text-xs hover:bg-accent disabled:cursor-default disabled:opacity-70";

/** The composer's textarea; static literals for the Tailwind scan (ADR 0004). */
const composerInputClass =
  "w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground focus:border-primary";

/** The primary "Send to Agent" action, disabled until the submit rule passes. */
const sendButtonClass =
  "mt-2 w-full cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-50";

/**
 * Render the chrome page for a session (ADR 0004): a slim Tailwind/shadcn top bar
 * - filename, a Presence indicator (dot + label), the Annotate-mode toggle, and
 * the two working-copy controls - over a stage pairing the artifact's sandboxed,
 * opaque-origin iframe (ADR 0003) with a conversation panel. Behaviour lives in
 * the built controller at `/chrome.js`, fed the session's paths through the
 * inline JSON config; styling is the build-time Tailwind output at `/chrome.css`.
 * The iframe `src` is `/s/:key/a/`, so the artifact's relative URLs resolve under
 * that prefix with no `<base>` tag and no URL rewriting. The panel renders the
 * Conversation thread (replayed then appended live over the SSE stream; ADR 0010)
 * above a composer (message + Send to Agent) pinned to its bottom. The Presence
 * dot is authored at its idle color statically; `chrome.js` swaps the live colors.
 */
export const renderChrome = (params: ChromeParams): string => {
  const safeFilename = escapeHtml(params.filename);
  const iframeSrc = `/s/${params.key}/a/`;
  const sourceUrl = `/s/${params.key}/source`;
  const configJson = jsonForScript({
    path: params.path,
    sourceUrl,
    key: params.key,
  });
  return `<!doctype html>
<html lang="en" class="h-full">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>intervu - ${safeFilename}</title>
    <link rel="stylesheet" href="/chrome.css" />
  </head>
  <body class="flex h-full flex-col bg-background font-sans text-foreground">
    <header class="flex h-11 flex-none items-center gap-3 border-b border-border bg-surface px-3">
      <span class="text-[13px] font-semibold tracking-[0.02em]">intervu</span>
      <span class="truncate text-[13px] text-muted-foreground" title="${escapeHtml(params.path)}">${safeFilename}</span>
      <span class="flex flex-none items-center gap-1.5" data-presence title="agent presence">
        <span class="h-2 w-2 rounded-full bg-zinc-400" data-presence-dot></span>
        <span class="text-xs text-muted-foreground" data-presence-label>idle</span>
      </span>
      <div class="ml-auto flex gap-2">
        <button type="button" class="${buttonClass} aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground" data-annotate-toggle aria-pressed="false">Annotate</button>
        <button type="button" class="${buttonClass}" data-copy-path>Copy path</button>
        <button type="button" class="${buttonClass}" data-copy-source>Copy source</button>
      </div>
    </header>
    <main class="flex min-h-0 flex-1">
      <iframe
        class="h-full w-full flex-1 border-0 bg-background"
        src="${iframeSrc}"
        title="${safeFilename}"
        sandbox="allow-scripts allow-forms allow-popups"
        data-artifact
      ></iframe>
      <aside class="flex w-80 flex-none flex-col border-l border-border bg-panel">
        <div class="min-h-0 flex-1 overflow-y-auto p-4" data-panel-scroll>
          <h2 class="m-0 mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Pending annotations</h2>
          <p class="m-0 text-[13px] leading-relaxed text-muted-foreground" data-pending-empty>No annotations yet. Turn on Annotate, then point at elements and text in the artifact.</p>
          <ul class="m-0 mt-3 hidden list-none p-0" data-pending-list></ul>
          <h2 class="m-0 mb-2 mt-6 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Conversation</h2>
          <p class="m-0 text-[13px] leading-relaxed text-muted-foreground" data-conversation-empty>No messages yet. Your feedback and the agent's replies will appear here.</p>
          <div class="mt-3 flex flex-col gap-2" data-conversation></div>
        </div>
        <div class="flex-none border-t border-border p-3" data-composer>
          <textarea class="${composerInputClass}" data-composer-input rows="3" placeholder="Message to the agent..." aria-label="Message to the agent"></textarea>
          <button type="button" class="${sendButtonClass}" data-send disabled>Send to Agent</button>
        </div>
      </aside>
    </main>
    <script type="application/json" id="intervu-config">${configJson}</script>
    <script src="/chrome.js"></script>
  </body>
</html>
`;
};
