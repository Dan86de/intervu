import { Schema } from "effect";

/**
 * Stable identifier for a Session: the SHA-256 hex of the artifact's resolved
 * realpath, truncated to 16 chars (ADR 0001). Path-derived, so it survives the
 * agent's live edits to the artifact's bytes.
 */
export const SessionKey = Schema.String.pipe(Schema.brand("SessionKey"));
export type SessionKey = typeof SessionKey.Type;

/**
 * A Session's lifecycle status. `open` on a created or resumed Session; `ended`
 * once the human or the agent ends it (`SessionStore.end`). The transition is
 * reversible (ADR 0012): re-opening an `ended` path resurrects it to `open`.
 */
export const SessionStatus = Schema.Literals(["open", "ended"]);
export type SessionStatus = typeof SessionStatus.Type;

/**
 * The review context for one artifact, keyed by its path-derived `key`. The
 * daemon's `SessionStore` solely owns these (ADR 0002); they cross the HTTP
 * boundary and persist to the state file via the same schema.
 */
export class Session extends Schema.Class<Session>("Session")({
  key: SessionKey,
  path: Schema.String,
  status: SessionStatus,
}) {}
