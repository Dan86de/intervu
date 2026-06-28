import { describe, expect, it } from "@effect/vitest";
import * as Output from "../src/Output.ts";
import { Feedback } from "../src/Protocol.ts";

describe("Output.home", () => {
  it("shapes the home view in canonical key order", () => {
    const view = Output.home({
      help: "do the thing",
      sessions: [],
      bin: "intervu",
      description: "desc",
    });

    expect(Object.keys(view)).toEqual([
      "bin",
      "description",
      "sessions",
      "help",
    ]);
    expect(view).toEqual({
      bin: "intervu",
      description: "desc",
      sessions: [],
      help: "do the thing",
    });
  });
});

describe("Output.session", () => {
  it("shapes the session view in canonical key order", () => {
    const view = Output.session({
      help: "next",
      status: "open",
      path: "/tmp/a.html",
      key: "abc",
    });

    expect(Object.keys(view)).toEqual(["key", "path", "status", "help"]);
    expect(view).toEqual({
      key: "abc",
      path: "/tmp/a.html",
      status: "open",
      help: "next",
    });
  });
});

describe("Output.error", () => {
  it("shapes a structured error view", () => {
    const view = Output.error({
      tag: "NotFound",
      message: "missing",
      help: "retry",
    });

    expect(view).toEqual({
      error: { tag: "NotFound", message: "missing" },
      help: "retry",
    });
  });
});

describe("Output.pollFeedback", () => {
  it("numbers annotations and keeps selectedText only on the text kind", () => {
    const feedback = new Feedback({
      message: "tighten these",
      annotations: [
        { kind: "element", selector: "#card", tag: "div", text: "Card body" },
        {
          kind: "text",
          selector: "#card h3",
          tag: "h3",
          text: "Heading",
          selectedText: "Head",
        },
      ],
      domSnapshot: "<html><body>snap</body></html>",
    });

    const view = Output.pollFeedback({
      feedback: [feedback],
      help: "next step",
    });

    expect(Object.keys(view)).toEqual(["feedback", "help"]);
    const item = view.feedback[0];
    expect(item?.message).toBe("tighten these");
    // domSnapshot is the last key of each feedback item.
    expect(Object.keys(item ?? {})).toEqual([
      "message",
      "annotations",
      "domSnapshot",
    ]);
    expect(item?.annotations[0]).toEqual({
      n: 1,
      kind: "element",
      selector: "#card",
      tag: "div",
      text: "Card body",
    });
    expect(item?.annotations[1]).toEqual({
      n: 2,
      kind: "text",
      selector: "#card h3",
      tag: "h3",
      text: "Heading",
      selectedText: "Head",
    });
    // The element annotation carries no selectedText key at all.
    expect(item?.annotations[0] && "selectedText" in item.annotations[0]).toBe(
      false,
    );
    expect(item?.domSnapshot).toBe("<html><body>snap</body></html>");
  });

  it("renders a drained collection in order", () => {
    const view = Output.pollFeedback({
      feedback: [
        new Feedback({ message: "first", annotations: [], domSnapshot: "a" }),
        new Feedback({ message: "second", annotations: [], domSnapshot: "b" }),
      ],
      help: "next",
    });

    expect(view.feedback.map((item) => item.message)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("Output.pollTimedOut", () => {
  it("shapes the distinct expiry view", () => {
    const view = Output.pollTimedOut({ help: "keep listening" });

    expect(view).toEqual({ timedOut: true, help: "keep listening" });
    expect(Object.keys(view)).toEqual(["timedOut", "help"]);
  });
});

describe("Output.pollEnded", () => {
  it("shapes a plain end (no final feedback) in canonical order", () => {
    const view = Output.pollEnded({ feedback: [], help: "stop polling" });

    expect(view).toEqual({ ended: true, feedback: [], help: "stop polling" });
    expect(Object.keys(view)).toEqual(["ended", "feedback", "help"]);
  });

  it("carries the final feedback of a Send & end", () => {
    const view = Output.pollEnded({
      feedback: [
        new Feedback({
          message: "last word",
          annotations: [],
          domSnapshot: "x",
        }),
      ],
      help: "stop",
    });

    expect(view.ended).toBe(true);
    expect(view.feedback.map((item) => item.message)).toEqual(["last word"]);
  });
});

describe("Output.ended", () => {
  it("shapes the terminal end confirmation", () => {
    const view = Output.ended({ help: "re-run to reopen" });

    expect(view).toEqual({ ended: true, help: "re-run to reopen" });
    expect(Object.keys(view)).toEqual(["ended", "help"]);
  });
});

describe("Output.merge", () => {
  it("combines fragments with extra winning on conflict", () => {
    const merged = Output.merge(
      { bin: "intervu", help: "old" },
      { help: "new" },
    );

    expect(merged).toEqual({ bin: "intervu", help: "new" });
  });
});
