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
 *
 * It also opens the one server-to-browser SSE channel (ADR 0010) and fans its
 * frames out: Presence changes drive the top-bar indicator, Conversation appends
 * render as thread bubbles (the panel is purely SSE-driven, no optimistic local
 * insert), and a reload nudge re-points the iframe `src` with a cache-bust query,
 * re-posting the current Annotate-mode on load.
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

/** The Send & end / top-bar End feedback rider, serialized to the wire shape. */
interface EndRider {
  readonly message: string;
  readonly annotations: readonly Annotation[];
  readonly domSnapshot: string;
}

/**
 * End the Session over `POST /s/:key/end` (ADR 0011). A `null` rider is a plain
 * End (top-bar control, empty body); a rider is Send & end, posting the final
 * Feedback and the end in one atomic request. The ended UI is SSE-driven (the
 * `SessionEnded` frame), so this only reports whether the request was accepted.
 */
const postEnd = (key: string, rider: EndRider | null): Promise<boolean> =>
  fetch(`/s/${key}/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      rider === null
        ? {}
        : {
            feedback: {
              message: rider.message,
              annotations: rider.annotations.map(toWire),
              domSnapshot: rider.domSnapshot,
            },
          },
    ),
  }).then((response) => response.ok);

/**
 * Wire the composer: enable Send and Send & end under the submit rule (a
 * non-empty trimmed message or at least one annotation). Send captures the
 * snapshot, posts the Feedback, then clears on success or surfaces the failure
 * while preserving the message and annotations so the human can retry. Send & end
 * posts the same Feedback as a rider to the end endpoint (ADR 0011), atomically
 * delivering the final feedback and ending the Session; the ended UI itself is
 * SSE-driven, so on success it simply leaves the composer for the frame to hide.
 */
const createComposer = (
  iframe: HTMLIFrameElement,
  config: ChromeConfig,
  pending: Pending,
): void => {
  const input = document.querySelector("[data-composer-input]");
  const send = document.querySelector("[data-send]");
  const sendEndNode = document.querySelector("[data-send-end]");
  if (
    !(input instanceof HTMLTextAreaElement) ||
    !(send instanceof HTMLButtonElement)
  ) {
    return;
  }
  const sendEnd = sendEndNode instanceof HTMLButtonElement ? sendEndNode : null;
  const sendLabel = send.textContent ?? "Send to Agent";
  const endLabel = sendEnd?.textContent ?? "Send & end";

  const isValid = (): boolean =>
    input.value.trim().length > 0 || pending.annotations().length > 0;
  const sync = (): void => {
    const disabled = !isValid();
    send.disabled = disabled;
    if (sendEnd !== null) {
      sendEnd.disabled = disabled;
    }
  };

  const reset = (): void => {
    send.textContent = sendLabel;
    if (sendEnd !== null) {
      sendEnd.textContent = endLabel;
    }
    sync();
  };
  const fail = (button: HTMLButtonElement, text: string): void => {
    button.textContent = text;
    button.disabled = true;
    window.setTimeout(reset, 1600);
  };

  // Both actions need the live DOM the human annotated (ADR 0008); null if the
  // frame is gone or the SDK is silent, which fails the action.
  const captureRider = async (): Promise<EndRider | null> => {
    const snapshot = await requestSnapshot(iframe).catch(() => null);
    if (snapshot === null) {
      return null;
    }
    return {
      message: input.value,
      annotations: pending.annotations(),
      domSnapshot: snapshot,
    };
  };

  const submit = async (): Promise<void> => {
    if (!isValid()) {
      return;
    }
    send.disabled = true;
    if (sendEnd !== null) {
      sendEnd.disabled = true;
    }
    send.textContent = "Sending...";
    const rider = await captureRider();
    if (rider === null) {
      fail(send, "Send failed");
      return;
    }
    const ok = await postFeedback(
      config.key,
      rider.message,
      rider.annotations,
      rider.domSnapshot,
    ).catch(() => false);
    if (!ok) {
      fail(send, "Send failed");
      return;
    }
    input.value = "";
    pending.clear();
    reset();
  };

  const submitEnd = async (): Promise<void> => {
    if (sendEnd === null || !isValid()) {
      return;
    }
    send.disabled = true;
    sendEnd.disabled = true;
    sendEnd.textContent = "Ending...";
    const rider = await captureRider();
    if (rider === null) {
      fail(sendEnd, "End failed");
      return;
    }
    const ok = await postEnd(config.key, rider).catch(() => false);
    if (!ok) {
      fail(sendEnd, "End failed");
      return;
    }
    // Success: the `SessionEnded` SSE frame hides the composer and disables the
    // controls, so there is nothing to clear here.
  };

  input.addEventListener("input", sync);
  pending.onChange(sync);
  // `submit`/`submitEnd` resolve on their own (every await has a `.catch`), so
  // letting the returned promise settle untracked is safe here.
  send.addEventListener("click", () => {
    submit();
  });
  if (sendEnd !== null) {
    sendEnd.addEventListener("click", () => {
      submitEnd();
    });
  }
  sync();
};

/** The Presence dot's color per state; static literals for the Tailwind scan. */
const PRESENCE_DOTS = {
  idle: "bg-zinc-400",
  listening: "bg-emerald-500",
  working: "bg-amber-500",
} as const;

type Presence = keyof typeof PRESENCE_DOTS;

const isPresence = (value: unknown): value is Presence =>
  value === "idle" || value === "listening" || value === "working";

/**
 * Drive the top-bar Presence indicator (ADR 0010): swap the dot's color class and
 * the text label to the pushed state. The label is for accessibility, the dot for
 * glanceability; the colors are authored statically so the build-time Tailwind
 * scan captures them.
 */
const wirePresence = (): ((presence: Presence) => void) => {
  const dot = document.querySelector("[data-presence-dot]");
  const label = document.querySelector("[data-presence-label]");
  return (presence) => {
    if (dot instanceof HTMLElement) {
      dot.className = `h-2 w-2 rounded-full ${PRESENCE_DOTS[presence]}`;
    }
    if (label instanceof HTMLElement) {
      label.textContent = presence;
    }
  };
};

/** One Conversation entry as the chrome receives it over the SSE stream. */
interface ConversationEntry {
  readonly seq: number;
  readonly role: "human" | "agent";
  readonly text: string;
  readonly annotationCount: number;
}

const isConversationEntry = (value: unknown): value is ConversationEntry =>
  typeof value === "object" &&
  value !== null &&
  "seq" in value &&
  typeof value.seq === "number" &&
  "role" in value &&
  (value.role === "human" || value.role === "agent") &&
  "text" in value &&
  typeof value.text === "string" &&
  "annotationCount" in value &&
  typeof value.annotationCount === "number";

const ROLE_LABEL = { human: "Human", agent: "Agent" } as const;
const BUBBLE_BASE =
  "max-w-[85%] rounded-lg px-2.5 py-1.5 text-[13px] leading-relaxed";
const BUBBLE_ROLE = {
  human: "self-end bg-primary text-primary-foreground",
  agent: "self-start bg-accent text-foreground",
} as const;

/**
 * Render the Conversation thread purely from SSE frames (ADR 0010): append one
 * bubble per entry - agent left on a muted surface, human right with a primary
 * tint, each labeled - keyed by `seq` so a replayed-then-live overlap is
 * idempotent, auto-scrolling to the latest. An annotation-only human Feedback
 * carries an empty message, so it renders its annotation count, never a blank
 * bubble. All text is set via `textContent`, so a message can never inject markup.
 */
const createConversation = (): ((entry: ConversationEntry) => void) => {
  const container = document.querySelector("[data-conversation]");
  const empty = document.querySelector("[data-conversation-empty]");
  const scroller = document.querySelector("[data-panel-scroll]");
  const seen = new Set<number>();
  if (!(container instanceof HTMLElement)) {
    return () => {};
  }
  return (entry) => {
    if (seen.has(entry.seq)) {
      return;
    }
    seen.add(entry.seq);

    const bubble = document.createElement("div");
    bubble.dataset.seq = String(entry.seq);
    bubble.className = `${BUBBLE_BASE} ${BUBBLE_ROLE[entry.role]}`;

    const label = document.createElement("span");
    label.className =
      "mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.06em] opacity-70";
    label.textContent = ROLE_LABEL[entry.role];
    bubble.append(label);

    const body = document.createElement("p");
    body.className = "m-0 whitespace-pre-wrap break-words";
    const trimmed = entry.text.trim();
    if (trimmed.length === 0 && entry.annotationCount > 0) {
      body.classList.add("italic", "opacity-80");
      body.textContent = `${entry.annotationCount} annotation${
        entry.annotationCount === 1 ? "" : "s"
      }`;
    } else {
      body.textContent = entry.text;
    }
    bubble.append(body);

    container.append(bubble);
    if (empty instanceof HTMLElement) {
      empty.classList.add("hidden");
    }
    if (scroller instanceof HTMLElement) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  };
};

/** The chrome's current Annotate-mode, read from the toggle's pressed state. */
const currentMode = (): AnnotateMode =>
  document
    .querySelector("[data-annotate-toggle]")
    ?.getAttribute("aria-pressed") === "true"
    ? "on"
    : "off";

/**
 * Live-reload the artifact in place (ADR 0010). The opaque-origin iframe can't be
 * `location.reload()`-ed from the parent, so a reload reassigns its `src` with a
 * cache-bust query - which the daemon ignores for relative-asset resolution. On
 * every (re)load the chrome re-posts the current Annotate-mode down the Bridge, so
 * an edit never silently resets the mode the human left on. Returns the reload
 * trigger the SSE channel calls; pending rows survive (they live in the chrome),
 * the in-iframe markers do not.
 */
const wireLiveReload = (
  iframe: HTMLIFrameElement,
  config: ChromeConfig,
): (() => void) => {
  let bust = 0;
  iframe.addEventListener("load", () => {
    const frame = iframe.contentWindow;
    if (frame !== null) {
      postToFrame(frame, { kind: "set-mode", mode: currentMode() });
    }
  });
  return () => {
    bust += 1;
    iframe.src = `/s/${config.key}/a/?r=${bust}`;
  };
};

/**
 * Apply the ended state (ADR 0011), driven by the `SessionEnded` SSE frame and
 * idempotent so the replay-on-connect and a live end converge: swap the presence
 * indicator for the "Ended" pill in the same region, replace the composer with
 * the muted ended note, and disable the Annotate and End controls. The artifact
 * iframe stays visible and frozen - no further annotations can be captured.
 */
const applyEnded = (): void => {
  document.querySelector("[data-presence]")?.classList.add("hidden");
  const pill = document.querySelector("[data-ended-pill]");
  if (pill instanceof HTMLElement) {
    pill.classList.remove("hidden");
    pill.classList.add("inline-flex");
  }
  document.querySelector("[data-composer]")?.classList.add("hidden");
  document.querySelector("[data-ended-note]")?.classList.remove("hidden");
  for (const selector of [
    "[data-annotate-toggle]",
    "[data-end-session]",
    "[data-send]",
    "[data-send-end]",
  ]) {
    const control = document.querySelector(selector);
    if (control instanceof HTMLButtonElement) {
      control.disabled = true;
    }
  }
};

/**
 * Wire the top-bar End session control (ADR 0011): a plain End with no rider,
 * available until the Session ends. The ended UI is SSE-driven, so this only
 * POSTs and re-enables on failure - the `SessionEnded` frame does the rest.
 */
const wireEndSession = (config: ChromeConfig): void => {
  const button = document.querySelector("[data-end-session]");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  button.addEventListener("click", () => {
    button.disabled = true;
    postEnd(config.key, null)
      .catch(() => false)
      .then((ok) => {
        if (!ok) {
          button.disabled = false;
        }
      });
  });
};

/**
 * Open the one server-to-browser SSE channel (ADR 0010) and fan its frames out to
 * the indicator, the thread, the iframe reload, and the ended state. `EventSource`
 * reconnects transparently and resumes the thread from `Last-Event-ID`, so a
 * dropped connection never duplicates a bubble. On a `SessionEnded` frame the
 * chrome applies the ended state and closes its own `EventSource`, which tears
 * down the server stream via the existing client-disconnect path (ADR 0011).
 * Every frame is untrusted JSON, validated before it touches the DOM.
 */
const createLiveChannel = (
  config: ChromeConfig,
  handlers: {
    readonly setPresence: (presence: Presence) => void;
    readonly appendConversation: (entry: ConversationEntry) => void;
    readonly reload: () => void;
    readonly ended: () => void;
  },
): void => {
  const source = new EventSource(`/s/${config.key}/events`);
  source.addEventListener("message", (event) => {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof data !== "object" || data === null || !("_tag" in data)) {
      return;
    }
    if (
      data._tag === "PresenceChanged" &&
      "presence" in data &&
      isPresence(data.presence)
    ) {
      handlers.setPresence(data.presence);
    } else if (
      data._tag === "ConversationAppended" &&
      isConversationEntry(data)
    ) {
      handlers.appendConversation(data);
    } else if (data._tag === "ArtifactReloaded") {
      handlers.reload();
    } else if (data._tag === "SessionEnded") {
      handlers.ended();
      source.close();
    }
  });
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
  wireEndSession(config);
  const iframe = document.querySelector("[data-artifact]");
  if (iframe instanceof HTMLIFrameElement) {
    wireToggle(iframe);
    const pending = createPending(iframe);
    createComposer(iframe, config, pending);
    const reload = wireLiveReload(iframe, config);
    createLiveChannel(config, {
      setPresence: wirePresence(),
      appendConversation: createConversation(),
      reload,
      ended: applyEnded,
    });
  }
};

main();
