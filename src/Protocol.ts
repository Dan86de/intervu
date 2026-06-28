import { Schema } from "effect";

/**
 * The wire schemas for the daemon's HTTP surface. The CLI (client) and the
 * daemon (server) share these so a request the client encodes is exactly what
 * the server decodes.
 */

/**
 * `GET /health` response. `version` is present now so the later
 * stale-server-takeover slice (#27) has its handshake field.
 */
export class Health extends Schema.Class<Health>("Health")({
  ok: Schema.Boolean,
  version: Schema.String,
}) {}

/**
 * `POST /sessions` request body: the artifact's resolved realpath. The daemon
 * derives the Session key from this path, so the CLI resolves it before sending.
 */
export class OpenSessionRequest extends Schema.Class<OpenSessionRequest>(
  "OpenSessionRequest",
)({
  path: Schema.String,
}) {}
