import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { CliError } from "effect/unstable/cli";
import * as ErrorReport from "../src/ErrorReport.ts";
import {
  ArtifactNotFound,
  DaemonNotRunning,
  ReviewNotOpen,
  ServerStartTimeout,
} from "../src/Errors.ts";

const ctx = { logFile: "/state/server.log" } as const;

describe("ErrorReport.report", () => {
  it("tailors a domain error to its tag, message, and next-step help", () => {
    const view = ErrorReport.report(
      new ArtifactNotFound({ path: "/tmp/missing.html" }),
      ctx,
    );

    expect(Option.isSome(view)).toBe(true);
    const value = Option.getOrThrow(view);
    expect(value.error.tag).toBe("ArtifactNotFound");
    expect(value.error.message).toContain("/tmp/missing.html");
    expect(value.help).toContain("intervu <file>");
  });

  it("routes ReviewNotOpen back to opening the path", () => {
    const view = ErrorReport.report(
      new ReviewNotOpen({ path: "/tmp/a.html" }),
      ctx,
    );

    const value = Option.getOrThrow(view);
    expect(value.error.tag).toBe("ReviewNotOpen");
    expect(value.help).toContain("intervu /tmp/a.html");
  });

  it("points daemon-startup failures at the log", () => {
    const view = ErrorReport.report(
      new ServerStartTimeout({ port: 51789 }),
      ctx,
    );

    const value = Option.getOrThrow(view);
    expect(value.error.tag).toBe("ServerStartTimeout");
    expect(value.error.message).toContain("51789");
    expect(value.help).toContain(ctx.logFile);
  });

  it("guides DaemonNotRunning to spawn a daemon", () => {
    const view = ErrorReport.report(new DaemonNotRunning(), ctx);

    const value = Option.getOrThrow(view);
    expect(value.error.tag).toBe("DaemonNotRunning");
    expect(value.help).toContain("intervu <file>");
  });

  it("renders a generic envelope for infra errors, pointing at the log", () => {
    // Infra errors (HttpClientError / SchemaError / PlatformError) are matched
    // only by tag in the generic branch, so a tagged stand-in exercises it.
    const view = ErrorReport.report({ _tag: "HttpClientError" }, ctx);

    const value = Option.getOrThrow(view);
    expect(value.error.tag).toBe("HttpClientError");
    expect(value.error.message).toContain("unexpected error");
    expect(value.help).toContain(ctx.logFile);
  });

  it("no-ops on framework CliError - it is already rendered", () => {
    const view = ErrorReport.report(
      new CliError.ShowHelp({ commandPath: ["intervu"], errors: [] }),
      ctx,
    );

    expect(Option.isNone(view)).toBe(true);
  });
});
