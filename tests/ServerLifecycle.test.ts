import { describe, expect, it } from "@effect/vitest";
import { isStaleVersion } from "../src/ServerLifecycle.ts";

/**
 * The takeover predicate (ADR 0015): take over iff the running daemon is
 * strictly older than the client, compared as numeric `major.minor.patch`
 * tuples. Equal-or-newer is reused; an unparseable running version is stale.
 */
describe("isStaleVersion", () => {
  it("a strictly-older running version is stale", () => {
    expect(isStaleVersion("0.0.0", "0.0.1")).toBe(true);
    expect(isStaleVersion("0.1.0", "0.2.0")).toBe(true);
    expect(isStaleVersion("1.9.9", "2.0.0")).toBe(true);
    expect(isStaleVersion("1.2.3", "1.2.4")).toBe(true);
  });

  it("an equal version is reused, not stale", () => {
    expect(isStaleVersion("0.0.0", "0.0.0")).toBe(false);
    expect(isStaleVersion("1.2.3", "1.2.3")).toBe(false);
  });

  it("a strictly-newer running version is reused, not stale", () => {
    expect(isStaleVersion("0.0.2", "0.0.1")).toBe(false);
    expect(isStaleVersion("2.0.0", "1.9.9")).toBe(false);
    expect(isStaleVersion("1.2.4", "1.2.3")).toBe(false);
  });

  it("an unparseable running version counts as stale", () => {
    expect(isStaleVersion("", "0.0.1")).toBe(true);
    expect(isStaleVersion("nope", "0.0.1")).toBe(true);
    expect(isStaleVersion("1.2", "0.0.1")).toBe(true);
    expect(isStaleVersion("1.2.3.4", "0.0.1")).toBe(true);
  });

  it("an unparseable client version never evicts a running daemon", () => {
    expect(isStaleVersion("0.0.0", "garbage")).toBe(false);
  });
});
