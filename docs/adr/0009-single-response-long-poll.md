# poll is a single-response long-poll; cleanup rides Bun's request-scope abort

## Status

accepted

## Context and decision

`intervu poll <file>` must block silently until the human sends Feedback, return it as one TOON document, survive being killed and re-run, and never busy-wait.
This is the server-to-agent direction and is deliberately plain HTTP request/response - the server-to-browser push (live reload, agent replies, presence) is SSE in #7 and is a separate channel.

The poll is a single long-held request that returns exactly one TOON body: either the drained feedback collection, or - only when the optional `--timeout` cap is set - a `timedOut` marker.
The `FeedbackWait` primitive merges an internal heartbeat with a one-shot payload from the hub and store; the heartbeat keeps the wait suspended without resolving it and never writes to the wire, so the agent's output stays pure TOON.
The wait subscribes to `SessionHub` and then drains `takeFeedback` once, closing the queue-before-subscribe race, and blocks until the next `FeedbackQueued` signal or the timeout.
Cleanup is tied to the request scope: when the agent kills `poll`, Bun fires `request.signal`'s `abort`, which interrupts the handler fiber (`BunHttpServer` wires `request.signal` to `fiber.interruptUnsafe`), running the scoped finalizer that releases the hub subscription.
The CLI disables its response timeout for the poll request so an indefinite block is not severed client-side.

## Considered options

- **Single-response long-poll, internal heartbeat, scope cleanup** - chosen: the agent's output is one pure-TOON document with no framing protocol, and cleanup is automatic through Bun's verified abort-to-interrupt wiring, which is sound because the daemon is loopback-only so a dead client always delivers FIN/RST locally.
- **Chunked / NDJSON stream with wire heartbeat frames the CLI discards** - rejected: it keeps an indefinite connection demonstrably warm and detects a broken pipe by write failure, but it forces a framing protocol that coexists awkwardly with multi-line TOON and muddies "all CLI output is TOON".

## Consequences

- The heartbeat has no wire role on loopback; it is the internal merge element the `FeedbackWait` unit test pins ("a tick does not resolve the wait").
- If the daemon ever served non-loopback clients, a half-open connection without FIN/RST would need a heartbeat write-probe to detect death; out of scope while loopback-only.
- `takeFeedback` is the single source of truth and the hub only signals, so a poll that loses a take race re-waits rather than returning empty.
- The bounded timeout returns `timedOut: true`, not "waiting" - that word is retired in CONTEXT.md as a presence synonym; the default remains an indefinite block.
