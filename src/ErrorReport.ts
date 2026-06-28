import { Option } from "effect";
import { CliError } from "effect/unstable/cli";
import {
  ArtifactNotFound,
  BrowserAssetBuildError,
  DaemonNotRunning,
  ReviewNotOpen,
  ServerStartTimeout,
} from "./Errors.ts";
import * as Output from "./Output.ts";

/**
 * The structured error contract (ADR 0014). Classifies a failure that reached
 * the CLI's `emit` seam into one of three tiers and shapes the first two into a
 * TOON envelope; the third is rendered elsewhere:
 *
 * - **Domain `TaggedError`s** get a tailored message plus a per-tag next-step
 *   help line, so the agent recovers in one turn.
 * - **Infra typed errors** (`HttpClientError` / `SchemaError` / `PlatformError`)
 *   get a generic envelope pointing at the daemon log.
 * - **Framework parse/usage errors** (`CliError`) return `Option.none()`: the
 *   Effect CLI framework already printed its own help doc, so this no-ops rather
 *   than double-printing.
 *
 * Defects (`die`) never reach here - they are tapped separately and left raw on
 * stderr - so this stays a total mapping over the typed-error channel.
 *
 * The parameter is the structural minimum (`{ _tag }`) every tagged failure
 * satisfies, so the whole inferred error union flows in without naming it; the
 * `instanceof` checks narrow precisely to the domain classes.
 */
export const report = (
  error: { readonly _tag: string },
  ctx: { readonly logFile: string },
): Option.Option<Output.ErrorView> => {
  // Framework parse/usage errors (e.g. a missing `<file>` argument) keep the
  // CLI framework's own rendering, which already hit stdout (ADR 0014).
  if (CliError.isCliError(error)) {
    return Option.none();
  }

  if (error instanceof ArtifactNotFound) {
    return Option.some(
      Output.error({
        tag: error._tag,
        message: `artifact not found: ${error.path}`,
        help: "check the path - run 'intervu <file>' with an existing artifact",
      }),
    );
  }

  if (error instanceof ReviewNotOpen) {
    return Option.some(
      Output.error({
        tag: error._tag,
        message: `no open review for ${error.path}`,
        help: `open it first - run 'intervu ${error.path}'`,
      }),
    );
  }

  if (error instanceof DaemonNotRunning) {
    return Option.some(
      Output.error({
        tag: error._tag,
        message: "the review daemon is not running",
        help: "start a review - run 'intervu <file>' to spawn the daemon",
      }),
    );
  }

  if (error instanceof ServerStartTimeout) {
    return Option.some(
      Output.error({
        tag: error._tag,
        message: `the daemon did not become healthy on port ${error.port}`,
        help: `check the daemon log at ${ctx.logFile}, then re-run 'intervu <file>'`,
      }),
    );
  }

  if (error instanceof BrowserAssetBuildError) {
    return Option.some(
      Output.error({
        tag: error._tag,
        message: `browser asset build failed: ${error.reason}`,
        help: `check the daemon log at ${ctx.logFile}`,
      }),
    );
  }

  // Infra typed errors (`HttpClientError` / `SchemaError` / `PlatformError`):
  // not actionable per-tag, so point the agent at the daemon log.
  return Option.some(
    Output.error({
      tag: error._tag,
      message: "the review daemon returned an unexpected error",
      help: `check the daemon log at ${ctx.logFile}`,
    }),
  );
};
