# Home view reads the persisted session set directly

The bare-`intervu` home view must give the agent ambient context with zero network calls and work even when no daemon is running.
We read the `open` Sessions straight from the persisted state file (`SessionPersistence.load`), not through the daemon - a deliberate read-only exception to ADR 0002 (the daemon owns session state).

This is safe because the state file is rewritten on every `open`/`end`, so it is the faithful source for the `{key, path, status}` the home view shows, and the view deliberately shows nothing daemon-only: there is no **Presence** in the home view (Presence is in-memory daemon state).
A reader who assumes ADR 0002 applies everywhere might "fix" this to query the daemon over HTTP; that would reintroduce a daemon dependency and a network call for what is purely an ambient read, which is exactly what this decision avoids.

## Consequences

- If the state file lists an `open` Session but the daemon is down, the home view still shows it (it never probes). Recovery rides the existing error path: a subsequent `poll` fails with `DaemonNotRunning`, whose next-step help routes to `intervu <file>`, which self-spawns the daemon and resumes the Session.
- `ended` Sessions are omitted from the home view; "live" means `open`.
