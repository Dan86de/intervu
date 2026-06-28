# Poll's ended outcome can carry a final feedback

When the human uses **Send & end**, the agent's waiting **Poll** must learn two facts at once: the final **Feedback**, and that the **Session** ended.
We make `PollResponse` carry an `ended` flag that may co-occur with `feedback` - rather than keeping feedback / `timedOut` / `ended` mutually exclusive and delivering the final feedback on one poll and `ended` on the next.
So the combined action settles in a single poll: the agent applies the final feedback, sees `ended`, and stops without an extra round-trip.

The `POST /s/:key/end` handler applies the optional final feedback and the status flip to the store *before* publishing the wake signal, so the poll's settle drains the feedback and reads `ended` atomically (the store, not the signal, is the source of truth - as with `FeedbackQueued` / `takeFeedback`).

## Considered Options

- **Co-occurring `ended` + `feedback` (chosen).** One round-trip for Send & end; AXI turn economy. Cost: feedback and ended are coupled, so the agent must check `ended` even on a feedback-bearing return.
- **Mutually exclusive across two polls.** Purer documents (feedback | timedOut | ended), but the agent pays an extra poll after its final edit to discover the end.

Extends ADR 0009 (single-response long-poll); the three settle reasons are now feedback, `timedOut`, and `ended`.
