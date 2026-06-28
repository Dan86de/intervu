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

/**
 * The server-side mirror of the in-iframe SDK's `Annotation` union (CONTEXT.md
 * "Annotation"; ADR 0005), discriminated on `kind` to match what the chrome
 * posts. The iframe-minted `id` is dropped at this boundary: queue order is the
 * ordering this slice and the poll's 1-based `n` is the badge the human saw.
 */
const ElementAnnotation = Schema.Struct({
  kind: Schema.Literal("element"),
  selector: Schema.String,
  tag: Schema.String,
  text: Schema.String,
});

/** A `text` annotation also carries the selected run of text it anchors to. */
const TextAnnotation = Schema.Struct({
  kind: Schema.Literal("text"),
  selector: Schema.String,
  tag: Schema.String,
  text: Schema.String,
  selectedText: Schema.String,
});

/** Either annotation kind; discriminated on `kind`. */
export const Annotation = Schema.Union([ElementAnnotation, TextAnnotation]);
export type Annotation = typeof Annotation.Type;

/**
 * One human submission (CONTEXT.md "Feedback"): a message, its stacked
 * annotations, and the live DOM snapshot the selectors resolve against (ADR
 * 0008). Crosses the wire as the `POST /s/:key/feedback` body and rides inline
 * in the poll response. Validity (`ValidFeedback`) is re-checked server-side so
 * the queue never holds an empty Feedback.
 */
export class Feedback extends Schema.Class<Feedback>("Feedback")({
  message: Schema.String,
  annotations: Schema.Array(Annotation),
  domSnapshot: Schema.String,
}) {}

/**
 * A Feedback that satisfies the submit rule: a non-empty trimmed message or at
 * least one annotation. The Send button gates on the same rule; this is the
 * server-side re-check on `POST /s/:key/feedback`.
 */
export const ValidFeedback = Feedback.check(
  Schema.makeFilter((feedback) =>
    feedback.message.trim().length > 0 || feedback.annotations.length > 0
      ? undefined
      : "feedback needs a non-empty message or at least one annotation",
  ),
);

/**
 * `POST /poll` request body (ADR 0009): the artifact's resolved realpath, which
 * the daemon looks up without creating. `timeoutSeconds`, when present, bounds
 * the long-poll and turns an expiry into a `timedOut` response; absent means the
 * default indefinite block.
 */
export class PollRequest extends Schema.Class<PollRequest>("PollRequest")({
  path: Schema.String,
  timeoutSeconds: Schema.optional(Schema.Number),
}) {}

/**
 * `POST /poll` response body: either the drained feedback (`timedOut: false`,
 * one or more Feedback) or, only when the request set a timeout, the expiry
 * marker (`timedOut: true`, empty feedback). The CLI shapes the TOON the agent
 * sees from this.
 */
export class PollResponse extends Schema.Class<PollResponse>("PollResponse")({
  timedOut: Schema.Boolean,
  feedback: Schema.Array(Feedback),
}) {}
