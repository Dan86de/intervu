import { postToFrame } from "../sdk/bridge.ts";
import type { AnnotateMode } from "../sdk/protocol.ts";

/**
 * The chrome controller (CONTEXT.md "Chrome"; ADR 0004 / 0006), served at
 * `/chrome.js` and loaded by the chrome page that wraps the artifact iframe.
 * Plain DOM TypeScript, no Effect. This slice owns the top-bar behaviour: the
 * two working-copy controls and the Annotate-mode toggle, which flips its
 * pressed state and tells the in-iframe SDK over the Bridge. The pending-
 * annotations list and its rows arrive with click/text capture; the panel ships
 * here as the honest empty shell.
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
  }
};

main();
