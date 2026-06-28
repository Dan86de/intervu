import { describe, expect, it } from "@effect/vitest";
import * as Output from "../src/Output.ts";

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

describe("Output.merge", () => {
  it("combines fragments with extra winning on conflict", () => {
    const merged = Output.merge(
      { bin: "intervu", help: "old" },
      { help: "new" },
    );

    expect(merged).toEqual({ bin: "intervu", help: "new" });
  });
});
