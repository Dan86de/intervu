import { Option } from "effect";
import type { ConversationEntry, Presence } from "./Protocol.ts";
import type { HubEvent } from "./SessionHub.ts";

/**
 * Pure Server-Sent Events framing for the daemon's SSE stream (ADR 0010), kept
 * free of effects and IO so it is deterministic and unit testable like
 * `ArtifactAssets` and `Output`. Every frame's `data:` is one line of JSON, not
 * TOON: the SSE wire is browser-facing, consumed by `EventSource`/JS (CONTEXT.md
 * flagged ambiguity scoping TOON to CLI stdout). `JSON.stringify` escapes any
 * newline in a Conversation message to `\n`, so the payload never spans lines and
 * a single `data:` line is always correct.
 *
 * Only `ConversationAppended` carries an `id:` (its monotonic `seq`), so a
 * transparent `EventSource` reconnect resumes the thread from `Last-Event-ID`.
 * Presence is current-state and a reload is momentary; neither is replayable, so
 * neither carries an `id`.
 */

/** A `: ping` comment every ~20s keeps the connection warm (ADR 0010 insurance). */
export const PING_FRAME = ": ping\n\n";

const frame = (data: string, id?: number): string =>
  `${id === undefined ? "" : `id: ${id}\n`}data: ${data}\n\n`;

/** A Conversation entry as an `id`-carrying frame the chrome renders as a bubble. */
export const conversationFrame = (entry: ConversationEntry): string =>
  frame(
    JSON.stringify({
      _tag: "ConversationAppended",
      seq: entry.seq,
      role: entry.role,
      text: entry.text,
      annotationCount: entry.annotationCount,
    }),
    entry.seq,
  );

/** The current Presence as an `id`-less frame (re-sent fresh on each connect). */
export const presenceFrame = (presence: Presence): string =>
  frame(JSON.stringify({ _tag: "PresenceChanged", presence }));

/** The momentary reload nudge; the browser owns its own cache-bust counter. */
export const reloadFrame = (): string =>
  frame(JSON.stringify({ _tag: "ArtifactReloaded" }));

/**
 * The Session ended (ADR 0011 / 0012): the chrome swaps in the "Ended" pill,
 * replaces the composer with the ended note, disables the Annotate and End
 * controls, and closes its own `EventSource`. `id`-less: it is current-state
 * (replayed fresh on connect to an already-ended Session), not a thread entry.
 */
export const endedFrame = (): string =>
  frame(JSON.stringify({ _tag: "SessionEnded" }));

/**
 * Map a live hub event to its SSE frame, or `None` for `FeedbackQueued` - the
 * poll's wake-signal, which the SSE route ignores so it never reaches the browser.
 */
export const liveFrame = (event: HubEvent): Option.Option<string> => {
  switch (event._tag) {
    case "FeedbackQueued":
      return Option.none();
    case "ConversationAppended":
      return Option.some(conversationFrame(event.entry));
    case "PresenceChanged":
      return Option.some(presenceFrame(event.presence));
    case "ArtifactReloaded":
      return Option.some(reloadFrame());
    case "SessionEnded":
      return Option.some(endedFrame());
  }
};

/**
 * Parse an `EventSource` `Last-Event-ID` header into a replay cursor: a positive
 * integer `seq`, or `0` when the header is absent or malformed (a first connect
 * replays the whole Conversation).
 */
export const parseLastEventId = (header: string | undefined): number => {
  if (header === undefined) {
    return 0;
  }
  const parsed = Number.parseInt(header, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};
