import { onMessageFromFrame, postToFrame } from "../sdk/bridge.ts";
import type { AnnotateMode, Annotation } from "../sdk/protocol.ts";

/**
 * The chrome controller (CONTEXT.md "Chrome"; ADR 0004 / 0006 / 0008), served at
 * `/chrome.js` and loaded by the chrome page that wraps the artifact iframe.
 * Plain DOM TypeScript, no Effect. It owns the top-bar controls and the
 * Annotate-mode toggle (which flips its pressed state and tells the in-iframe SDK
 * over the Bridge), the "Pending annotations" panel (each `annotation-added`
 * appends a numbered row; removing a row sends `annotation-removed` back so the
 * SDK clears its marker), and the composer: at Send it requests a live DOM
 * snapshot over the Bridge, posts the message-plus-annotations Feedback to the
 * daemon, and on success clears the composer, the rows, and the in-artifact
 * markers - preserving them on failure. Stacked annotations renumber to stay in
 * step with the in-artifact badges.
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

/**
 * The stacked annotations the human has captured but not yet sent. Owns both the
 * model (insertion-ordered, the order the badges show and the poll's `n` mirror)
 * and its panel rendering; `annotations()` is what Send serializes, and `clear()`
 * drops the rows and clears every in-artifact marker after a successful send.
 */
interface Pending {
  readonly annotations: () => readonly Annotation[];
  readonly clear: () => void;
  readonly onChange: (listener: () => void) => void;
}

const createPending = (iframe: HTMLIFrameElement): Pending => {
  const list = document.querySelector("[data-pending-list]");
  const empty = document.querySelector("[data-pending-empty]");
  const items = new Map<string, Annotation>();
  const listeners: Array<() => void> = [];
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  if (!(list instanceof HTMLUListElement) || !(empty instanceof HTMLElement)) {
    return {
      annotations: () => [],
      clear: () => {},
      onChange: (listener) => listeners.push(listener),
    };
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

  const clearMarker = (id: string): void => {
    const frame = iframe.contentWindow;
    if (frame !== null) {
      postToFrame(frame, { kind: "annotation-removed", id });
    }
  };

  const remove = (id: string): void => {
    const row = list.querySelector(`[data-pending-id="${CSS.escape(id)}"]`);
    if (row !== null) {
      row.remove();
    }
    items.delete(id);
    renumber();
    syncEmpty();
    clearMarker(id);
    notify();
  };

  onMessageFromFrame(iframe, (message) => {
    if (message.kind !== "annotation-added") {
      return;
    }
    const annotation = message.annotation;
    items.set(annotation.id, annotation);
    list.append(buildRow(annotation, () => remove(annotation.id)));
    renumber();
    syncEmpty();
    notify();
  });

  return {
    annotations: () => [...items.values()],
    clear: () => {
      for (const id of items.keys()) {
        clearMarker(id);
      }
      items.clear();
      list.replaceChildren();
      renumber();
      syncEmpty();
      notify();
    },
    onChange: (listener) => listeners.push(listener),
  };
};

/** The id-less wire shape of an annotation (Protocol mirror): queue order is identity. */
const toWire = (annotation: Annotation) =>
  annotation.kind === "text"
    ? {
        kind: "text",
        selector: annotation.selector,
        tag: annotation.tag,
        text: annotation.text,
        selectedText: annotation.selectedText,
      }
    : {
        kind: "element",
        selector: annotation.selector,
        tag: annotation.tag,
        text: annotation.text,
      };

/**
 * Capture the live DOM the human annotated (ADR 0008): post `snapshot-request`
 * down the Bridge and resolve with the `snapshot-result` the SDK returns. The
 * chrome cannot read the opaque-origin iframe directly, so this round-trip is the
 * only path. Rejects (caught by Send) if the frame is gone or the SDK is silent.
 */
const requestSnapshot = (iframe: HTMLIFrameElement): Promise<string> =>
  new Promise((resolve, reject) => {
    const frame = iframe.contentWindow;
    if (frame === null) {
      reject("no artifact frame");
      return;
    }
    let unsubscribe = (): void => {};
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject("snapshot timed out");
    }, 5000);
    unsubscribe = onMessageFromFrame(iframe, (message) => {
      if (message.kind !== "snapshot-result") {
        return;
      }
      window.clearTimeout(timer);
      unsubscribe();
      resolve(message.html);
    });
    postToFrame(frame, { kind: "snapshot-request" });
  });

const postFeedback = (
  key: string,
  message: string,
  annotations: readonly Annotation[],
  domSnapshot: string,
): Promise<boolean> =>
  fetch(`/s/${key}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      annotations: annotations.map(toWire),
      domSnapshot,
    }),
  }).then((response) => response.ok);

/**
 * Wire the composer: enable Send under the submit rule (a non-empty trimmed
 * message or at least one annotation), and on Send capture the snapshot, post the
 * Feedback, then clear on success or surface the failure while preserving the
 * message and annotations so the human can retry.
 */
const createComposer = (
  iframe: HTMLIFrameElement,
  config: ChromeConfig,
  pending: Pending,
): void => {
  const input = document.querySelector("[data-composer-input]");
  const send = document.querySelector("[data-send]");
  if (
    !(input instanceof HTMLTextAreaElement) ||
    !(send instanceof HTMLButtonElement)
  ) {
    return;
  }
  const label = send.textContent ?? "Send to Agent";

  const isValid = (): boolean =>
    input.value.trim().length > 0 || pending.annotations().length > 0;
  const sync = (): void => {
    send.disabled = !isValid();
  };

  const reset = (): void => {
    send.textContent = label;
    sync();
  };
  const fail = (): void => {
    send.textContent = "Send failed";
    send.disabled = true;
    window.setTimeout(reset, 1600);
  };

  const submit = async (): Promise<void> => {
    if (!isValid()) {
      return;
    }
    send.disabled = true;
    send.textContent = "Sending...";
    const snapshot = await requestSnapshot(iframe).catch(() => null);
    if (snapshot === null) {
      fail();
      return;
    }
    const ok = await postFeedback(
      config.key,
      input.value,
      pending.annotations(),
      snapshot,
    ).catch(() => false);
    if (!ok) {
      fail();
      return;
    }
    input.value = "";
    pending.clear();
    reset();
  };

  input.addEventListener("input", sync);
  pending.onChange(sync);
  // `submit` resolves on its own (every await has a `.catch`), so letting the
  // returned promise settle untracked is safe here.
  send.addEventListener("click", () => {
    submit();
  });
  sync();
};

const main = (): void => {
  const config = readConfig();
  if (config === null) {
    return;
  }
  wireCopy("[data-copy-path]", () => Promise.resolve(config.path));
  wireCopy("[data-copy-source]", () =>
    fetch(config.sourceUrl).then((response) => response.text()),
  );
  const iframe = document.querySelector("[data-artifact]");
  if (iframe instanceof HTMLIFrameElement) {
    wireToggle(iframe);
    const pending = createPending(iframe);
    createComposer(iframe, config, pending);
  }
};

main();
