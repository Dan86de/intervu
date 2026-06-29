import { Schema } from "effect";

/**
 * Domain errors that fail through the Effect error channel as
 * `Schema.TaggedError`s. Pretty structured-error rendering lands in slice #9;
 * until then `BunRuntime.runMain` renders these and exits 1.
 */

/** The artifact path could not be resolved to an existing file. */
export class ArtifactNotFound extends Schema.TaggedErrorClass<ArtifactNotFound>()(
  "ArtifactNotFound",
  {
    path: Schema.String,
  },
) {}

/** The daemon did not become healthy within the startup handshake window. */
export class ServerStartTimeout extends Schema.TaggedErrorClass<ServerStartTimeout>()(
  "ServerStartTimeout",
  {
    port: Schema.Number,
  },
) {}

/** `intervu stop` found no running daemon to signal. */
export class DaemonNotRunning extends Schema.TaggedErrorClass<DaemonNotRunning>()(
  "DaemonNotRunning",
  {},
) {}

/**
 * `intervu poll <file>` found no open Session for the path - the daemon is up
 * but nothing has been `open`ed there, so there is nothing to poll (ADR 0009).
 */
export class ReviewNotOpen extends Schema.TaggedErrorClass<ReviewNotOpen>()(
  "ReviewNotOpen",
  {
    path: Schema.String,
  },
) {}

/**
 * A stale (strictly-older) daemon answered `/health` on the port but could not
 * be evicted to take over (ADR 0015): the shared pidfile is missing or garbage,
 * or the daemon did not exit within the takeover window. The client refuses to
 * spawn into an occupied port and surfaces this instead.
 */
export class StaleServerTakeover extends Schema.TaggedErrorClass<StaleServerTakeover>()(
  "StaleServerTakeover",
  {
    port: Schema.Number,
    reason: Schema.String,
  },
) {}

/**
 * `intervu poll`/`end` found a stale (strictly-older) daemon (ADR 0015). The
 * spawn-free client paths (ADR 0009) do not take over inline; they refuse and
 * redirect the agent to re-run `intervu <file>` (which performs the takeover).
 */
export class StaleDaemon extends Schema.TaggedErrorClass<StaleDaemon>()(
  "StaleDaemon",
  {},
) {}

/**
 * A browser asset (the in-iframe SDK, the chrome controller, or the chrome
 * stylesheet) failed to build from source when the daemon started in dev. The
 * shipped binary serves baked assets and never hits this path.
 */
export class BrowserAssetBuildError extends Schema.TaggedErrorClass<BrowserAssetBuildError>()(
  "BrowserAssetBuildError",
  {
    reason: Schema.String,
  },
) {}

/**
 * `intervu setup` could not resolve the user's home directory, so it has no
 * user-level location to install the Skill into. Distinct from a no-op: a clean
 * install reports installed-now or already-present, this is a real failure.
 */
export class HomeDirectoryUnresolved extends Schema.TaggedErrorClass<HomeDirectoryUnresolved>()(
  "HomeDirectoryUnresolved",
  {},
) {}

/**
 * `intervu setup` found the harness settings file but could not read it (e.g. a
 * permissions error). Surfaced rather than silently skipping the Hook half.
 */
export class SettingsFileUnreadable extends Schema.TaggedErrorClass<SettingsFileUnreadable>()(
  "SettingsFileUnreadable",
  {
    path: Schema.String,
  },
) {}

/**
 * `intervu setup` read the harness settings file but it is not valid JSON (or
 * not the shape intervu expects). It is refused, never clobbered: a malformed
 * file is a clear structured error, so the user's config is left intact.
 */
export class SettingsFileUnparseable extends Schema.TaggedErrorClass<SettingsFileUnparseable>()(
  "SettingsFileUnparseable",
  {
    path: Schema.String,
  },
) {}

/**
 * `intervu setup` was given both `--skill-only` and `--hooks-only`, which
 * contradict each other - each restricts setup to exactly one half, so the two
 * together name no half at all. Refused with a clear message rather than
 * silently ignoring one of the flags.
 */
export class ConflictingSetupScope extends Schema.TaggedErrorClass<ConflictingSetupScope>()(
  "ConflictingSetupScope",
  {},
) {}
