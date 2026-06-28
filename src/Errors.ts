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
