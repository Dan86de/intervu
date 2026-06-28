# Ending a Session is reversible: re-open resurrects

The **Session** key is path-based (ADR 0001), so there is exactly one Session per artifact path for the daemon's life, and `ended` is persisted.
Making `ended` terminal would leave a reviewed file permanently un-reviewable - the same path can never mint a second Session - without manual state-file cleanup, and the dead status would survive a restart.
So `open` on an `ended` Session flips it back to `open` (same key, no duplicate state - exactly the idempotency #1 requires), and re-running `intervu <file>` starts a fresh review.

The transient queue and **Conversation** are not cleared on `end` or on resurrect (they are in-memory only, ADR 0002): within a daemon's life a resurrect resumes the thread, and after a restart it is naturally empty - no special-case reset, and the SSE `seq` cursor stays monotonic.

## Considered Options

- **Reversible / resurrect (chosen).** Re-open is the route back to a live review; `ended` is a soft status, not a wall.
- **Terminal `ended`.** Simpler state machine, but the path-based key makes it a dead end - the file is unreviewable until the daemon dies and persisted state is wiped.
