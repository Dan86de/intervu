# Feedback's DOM snapshot is the live iframe DOM, captured over the Bridge

## Status

accepted

## Context and decision

Every Feedback carries a DOM snapshot so the agent can resolve the annotation selectors against the document the human actually annotated.
There are only two possible sources: the artifact's on-disk bytes (already served at `/s/:key/source`) or the live, rendered DOM inside the artifact iframe.
They are identical for a static artifact and diverge for any artifact with JavaScript or human interaction - exactly the case Annotate-mode-off exists to support.
The annotation selectors are computed by `@medv/finder` against the live DOM, so only the live DOM resolves them deterministically.

The snapshot is the live DOM.
At Send, the chrome posts a `snapshot-request` down the Bridge; the in-iframe SDK serializes `document.documentElement.outerHTML` and returns it via `snapshot-result`.
The artifact iframe is sandboxed to an opaque origin (ADR 0003), so the chrome cannot read its DOM directly - the Bridge is the only path across that boundary.
The snapshot then rides inline in the Feedback to the server and inline in the poll's TOON to the agent.

## Considered options

- **Live iframe DOM over the Bridge** - chosen: it is exactly what the human annotated and what the selectors resolve against; it costs one Bridge round-trip and an `outerHTML` serialize.
- **On-disk source served by the daemon** - rejected: zero new browser code, but it is the pre-render source; for any interactive artifact the selectors point at nodes that do not exist in it and the surrounding-text context is wrong or empty.

## Consequences

- A new Bridge message pair (`snapshot-request` down, `snapshot-result` up) joins the protocol; the chrome awaits the result before POSTing and surfaces a failure rather than sending a partial Feedback.
- N queued sends carry N full-document snapshots, identical when the human did not interact between them; acceptable for single-page artifacts, dedupe is a later optimization if it ever bites.
- The top-bar "Copy DOM snapshot" control copies the on-disk source, which now collides with the **DOM snapshot** glossary term (the live DOM); it is relabeled "Copy source" to free the name.
