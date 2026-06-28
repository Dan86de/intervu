import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { ConversationEntry } from "../src/Protocol.ts";
import {
  ArtifactReloaded,
  ConversationAppended,
  FeedbackQueued,
  PresenceChanged,
  SessionEnded,
} from "../src/SessionHub.ts";
import * as Sse from "../src/Sse.ts";

/**
 * The pure SSE framing (ADR 0010): `id:`/`data:` shape, JSON (not TOON) payloads,
 * the `Last-Event-ID` cursor, and the `FeedbackQueued` filter. No effects, no IO.
 */

const entry = (over: Partial<ConversationEntry> = {}): ConversationEntry =>
  new ConversationEntry({
    seq: 1,
    role: "human",
    text: "tighten this",
    annotationCount: 0,
    ...over,
  });

describe("Sse", () => {
  it("frames a Conversation entry with its seq as the event id", () => {
    const frame = Sse.conversationFrame(entry({ seq: 7, annotationCount: 2 }));
    expect(frame).toBe(
      `id: 7\ndata: ${JSON.stringify({
        _tag: "ConversationAppended",
        seq: 7,
        role: "human",
        text: "tighten this",
        annotationCount: 2,
      })}\n\n`,
    );
  });

  it("keeps a multi-line message on a single data line", () => {
    const frame = Sse.conversationFrame(entry({ text: "line one\nline two" }));
    const dataLines = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
    expect(frame).toContain("line one\\nline two");
  });

  it("frames presence, reload, and ended without an id (not replayable)", () => {
    expect(Sse.presenceFrame("working")).toBe(
      `data: ${JSON.stringify({ _tag: "PresenceChanged", presence: "working" })}\n\n`,
    );
    expect(Sse.reloadFrame()).toBe(
      `data: ${JSON.stringify({ _tag: "ArtifactReloaded" })}\n\n`,
    );
    expect(Sse.endedFrame()).toBe(
      `data: ${JSON.stringify({ _tag: "SessionEnded" })}\n\n`,
    );
    expect(Sse.PING_FRAME).toBe(": ping\n\n");
  });

  it("maps live hub events to frames, dropping the poll's wake-signal", () => {
    expect(Sse.liveFrame(new FeedbackQueued())).toStrictEqual(Option.none());
    expect(
      Sse.liveFrame(new ConversationAppended({ entry: entry({ seq: 3 }) })),
    ).toStrictEqual(Option.some(Sse.conversationFrame(entry({ seq: 3 }))));
    expect(
      Sse.liveFrame(new PresenceChanged({ presence: "listening" })),
    ).toStrictEqual(Option.some(Sse.presenceFrame("listening")));
    expect(Sse.liveFrame(new ArtifactReloaded())).toStrictEqual(
      Option.some(Sse.reloadFrame()),
    );
    // Unlike FeedbackQueued, SessionEnded does reach the browser (ADR 0011).
    expect(Sse.liveFrame(new SessionEnded())).toStrictEqual(
      Option.some(Sse.endedFrame()),
    );
  });

  it("parses Last-Event-ID, defaulting malformed or absent to 0", () => {
    expect(Sse.parseLastEventId("5")).toBe(5);
    expect(Sse.parseLastEventId(undefined)).toBe(0);
    expect(Sse.parseLastEventId("nope")).toBe(0);
    expect(Sse.parseLastEventId("0")).toBe(0);
    expect(Sse.parseLastEventId("-3")).toBe(0);
  });
});
