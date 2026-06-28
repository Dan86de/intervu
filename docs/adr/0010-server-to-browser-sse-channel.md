# Server-to-browser push is one SSE channel off SessionHub

## Status

accepted

## Context and decision

Everything the daemon pushes back to the browser travels over a single Server-Sent Events response off `SessionHub` at `GET /s/:key/events`: the artifact live-reloading when the agent edits the file, the agent's Agent-replies landing in the conversation panel, and the Presence indicator (idle / listening / working).
This is the server-to-browser direction and is deliberately one-way SSE, the mirror of ADR 0009's server-to-agent long-poll.
The two browser-to-server directions already exist as plain `POST /s/:key/feedback` and the Bridge (ADR 0003), so nothing here needs a bidirectional socket.
The three pushes are multiplexed as tagged frames (`ConversationAppended`, `ArtifactReloaded`, `PresenceChanged`) over the one stream; the poll and the SSE route both subscribe to the same per-key hub and filter by tag, so `FeedbackQueued` stays the poll's wake-signal only (ADR 0009) and never reaches the browser.
The Conversation is the daemon's server-owned, in-memory source of truth: the human's Feedback messages and the agent's Agent-replies are appended to a per-key log in `SessionStore` (ADR 0002's sole owner of session state), each entry carrying a monotonic `seq`.
The SSE route replays that log on connect, and because `EventSource` reconnects transparently without clearing the rendered thread, it replays incrementally via the `Last-Event-ID` header so a reconnect never duplicates a bubble.
Presence is current-state and re-sent fresh on each connect; a reload nudge is momentary and never replayed.
The file watcher that drives live-reload is lazy and directory-scoped: it runs only while at least one SSE connection for a key is open, watches the artifact's parent directory filtered to its basename (robust to atomic-save rename-replace), and publishes `ArtifactReloaded` through the hub like every other push.
Cleanup rides the verified abort wiring: `BunHttpServer` interrupts the handler fiber on client disconnect (the same mechanism ADR 0009 depends on), releasing the hub subscription and decrementing the watcher's ref-count.

## Considered options

- **One-way SSE off the hub, server-owned Conversation log, Last-Event-ID replay** - chosen: the push is strictly one-way, SSE rides plain HTTP with no framing protocol, and `EventSource` gives auto-reconnect plus `Last-Event-ID` resumption for free, which is exactly the replay primitive the Conversation log needs.
- **WebSocket** - rejected: it buys a browser-to-server direction we do not need (feedback already posts over plain HTTP and the Bridge), and it forgoes `EventSource`'s built-in reconnect and Last-Event-ID semantics, which we would then hand-roll.
- **Ephemeral, browser-accumulated thread (no server log)** - rejected: an Agent-reply sent while no tab is connected would be lost, and a transparent reconnect would either drop history or duplicate it; a server-owned log replayed by `seq` makes both cases correct.

## Consequences

- The Conversation log is unbounded in memory for now; reviews are bounded and messages are small text, so a cap is deferred.
- Presence lives in `SessionHub` (open-poll count plus last-close-was-delivery), derived at the poll's `enterPoll` / `exitPoll` seams; a bare timeout or a killed poll drops to idle, not working.
- The chrome renders the conversation panel purely from replayed-then-live SSE frames with no optimistic local insert, so the human's own message round-trips through the server (imperceptible on loopback) and ordering has a single authority.
- If the daemon ever served non-loopback browsers, the `: ping` heartbeat would also become the liveness probe; on loopback it is insurance, since client disconnect aborts the request directly.
