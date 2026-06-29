# Idle self-shutdown via a single grace timer on live connections

The daemon reclaims itself when nobody is reviewing.
One watcher fiber, raced against `Layer.launch` in the `server` command, shuts the daemon down once the global **live-connection** count - open polls plus open SSE streams, tracked at the single `SessionHub.subscribe` seam in a reactive `SubscriptionRef` - has stayed zero for a grace window (default 30s, `INTERVU_IDLE_TIMEOUT`).
The watcher completing interrupts `Layer.launch`, which releases the server scope gracefully and runs the existing pidfile-cleanup finalizer.

We use **one unified condition** (`connections == 0`) rather than a separate immediate-on-end trigger.
An immediate "no open sessions and nothing connected" path would kill the daemon in the spawn->first-connect startup window (the client has not yet `POST /sessions` or connected its SSE), whereas a grace timer is startup-safe by construction.
A clean terminal `End` with no tab open therefore reclaims through the same timer - it just leaves the count at zero - at the cost of a ~30s linger instead of an instant exit.

## Considered options

- **A separate immediate shutdown when the last session ends with nothing connected** - rejected: unsafe at startup, and redundant once the grace timer exists. The only thing folding it in costs is a bounded linger on a clean end, which for a background process is a non-issue.
- **Counting only one connection kind** - rejected: the human's browser tab must hold the daemon open across the agent's edit-and-repoll gaps (SSE), and an open poll must hold it open in headless use, so both count equally.
- **Self-SIGTERM from the watcher** - rejected in favor of racing `Layer.launch`: it stays inside the Effect model (no signal round-trip) and is TestClock-testable like `FeedbackWait`.

## Consequences

- Combined with ADR 0009 (poll never spawns), an idle shutdown makes a subsequent `intervu poll` fail with `DaemonNotRunning`. Recovery is re-running `intervu <file>`, which respawns the daemon and resumes the persisted-`open` session - the help line on `DaemonNotRunning` already points there.
- Idle shutdown does not end sessions; it drops only the transient in-memory queue and Conversation (ADR 0002). A send-then-abandon race (the human stacks feedback while the agent is `working`, then closes the tab before the agent re-polls) can therefore lose that undrained feedback after the grace window. Accepted rather than guarding on a non-empty queue, which would reintroduce the indefinite dangle this feature exists to prevent.
