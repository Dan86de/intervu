import { onMessageFromFrame, postToFrame } from "../sdk/bridge.ts";
import type { AnnotateMode, Annotation } from "../sdk/protocol.ts";

/**
 * The chrome controller (CONTEXT.md "Chrome"; ADR 0004 / 0006), served at
 * `/chrome.js` and loaded by the chrome page that wraps the artifact iframe.
 * Plain DOM TypeScript, no Effect. It owns the top-bar controls and the
 * Annotate-mode toggle (which flips its pressed state and tells the in-iframe SDK
 * over the Bridge), and the "Pending annotations" panel: each `annotation-added`
 * from the iframe appends a numbered row, and removing a row sends
 * `annotation-removed` back so the SDK clears the matching marker. Stacked
 * annotations are renumbered to stay in step with the in-artifact badges.
 */

interface ChromeConfig {
  readonly path: string;
  readonly sourceUrl: string;
  readonly key: string;
}

const readConfig = (): ChromeConfig | null => {
  const element = document.getElementById("intervu-config");
  if (element === null || element.textContent === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(element.textContent);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const path =
    "path" in parsed && typeof parsed.path === "string" ? parsed.path : null;
  const sourceUrl =
    "sourceUrl" in parsed && typeof parsed.sourceUrl === "string"
      ? parsed.sourceUrl
      : null;
  const key =
    "key" in parsed && typeof parsed.key === "string" ? parsed.key : null;
  if (path === null || sourceUrl === null || key === null) {
    return null;
  }
  return { path, sourceUrl, key };
};

const flash = (button: HTMLButtonElement, label: string): void => {
  const original = button.dataset.label ?? button.textContent ?? "";
  button.textContent = label;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1200);
};

const wireCopy = (selector: string, getText: () => Promise<string>): void => {
  const button = document.querySelector(selector);
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  button.dataset.label = button.textContent ?? "";
  button.addEventListener("click", async () => {
    try {
      const text = await getText();
      await navigator.clipboard.writeText(text);
      flash(button, "Copied");
    } catch {
      flash(button, "Copy failed");
    }
  });
};

const wireToggle = (iframe: HTMLIFrameElement): void => {
  const toggle = document.querySelector("[data-annotate-toggle]");
  if (!(toggle instanceof HTMLButtonElement)) {
    return;
  }
  toggle.addEventListener("click", () => {
    const frame = iframe.contentWindow;
    if (frame === null) {
      return;
    }
    const next: AnnotateMode =
      toggle.getAttribute("aria-pressed") === "true" ? "off" : "on";
    toggle.setAttribute("aria-pressed", next === "on" ? "true" : "false");
    postToFrame(frame, { kind: "set-mode", mode: next });
  });
};

/**
 * Build a pending-annotation row from untrusted artifact data using only
 * `textContent`, so a selector or snippet can never inject markup. The badge
 * number is filled in by `renumber`; the row carries its annotation id for
 * removal. The class strings are static literals so the build-time Tailwind scan
 * (ADR 0004) catches them.
 */
const buildRow = (
  annotation: Annotation,
  onRemove: () => void,
): HTMLLIElement => {
  const row = document.createElement("li");
  row.dataset.pendingId = annotation.id;
  row.dataset.kind = annotation.kind;
  row.className =
    "mb-2 flex items-start gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-[13px]";

  const badge = document.createElement("span");
  badge.dataset.badge = "";
  badge.className =
    "mt-px inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground";
  row.append(badge);

  const body = document.createElement("div");
  body.className = "min-w-0 flex-1";
  const label = document.createElement("span");
  label.className = "block font-mono text-xs text-foreground";
  label.textContent = `<${annotation.tag}>`;
  const detail = document.createElement("span");
  detail.className = "block truncate text-muted-foreground";
  detail.textContent =
    annotation.kind === "text"
      ? `"${annotation.selectedText}"`
      : annotation.text;
  body.append(label, detail);
  row.append(body);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className =
    "ml-1 shrink-0 cursor-pointer rounded px-1 text-base leading-none text-muted-foreground hover:text-foreground";
  remove.setAttribute("aria-label", "Remove annotation");
  remove.textContent = "×";
  remove.addEventListener("click", onRemove);
  row.append(remove);

  return row;
};

const wirePending = (iframe: HTMLIFrameElement): void => {
  const list = document.querySelector("[data-pending-list]");
  const empty = document.querySelector("[data-pending-empty]");
  if (!(list instanceof HTMLUListElement) || !(empty instanceof HTMLElement)) {
    return;
  }

  const renumber = (): void => {
    list.querySelectorAll("[data-badge]").forEach((badge, index) => {
      badge.textContent = String(index + 1);
    });
  };

  const syncEmpty = (): void => {
    const hasRows = list.children.length > 0;
    list.classList.toggle("hidden", !hasRows);
    empty.classList.toggle("hidden", hasRows);
  };

  const removeAnnotation = (id: string): void => {
    const row = list.querySelector(`[data-pending-id="${CSS.escape(id)}"]`);
    if (row === null) {
      return;
    }
    row.remove();
    renumber();
    syncEmpty();
    const frame = iframe.contentWindow;
    if (frame !== null) {
      postToFrame(frame, { kind: "annotation-removed", id });
    }
  };

  onMessageFromFrame(iframe, (message) => {
    if (message.kind !== "annotation-added") {
      return;
    }
    const annotation = message.annotation;
    list.append(buildRow(annotation, () => removeAnnotation(annotation.id)));
    renumber();
    syncEmpty();
  });
};

const main = (): void => {
  const config = readConfig();
  if (config === null) {
    return;
  }
  wireCopy("[data-copy-path]", () => Promise.resolve(config.path));
  wireCopy("[data-copy-snapshot]", () =>
    fetch(config.sourceUrl).then((response) => response.text()),
  );
  const iframe = document.querySelector("[data-artifact]");
  if (iframe instanceof HTMLIFrameElement) {
    wireToggle(iframe);
    wirePending(iframe);
  }
};

main();
