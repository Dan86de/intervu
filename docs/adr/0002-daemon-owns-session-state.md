# Shared background daemon owns session state; the CLI is a thin HTTP client

## Status

accepted

## Context and decision

`intervu open <file>` (the bare-file alias) must print the Session and exit 0, yet a review Session has to persist across invocations, be reused by a second `open`, and survive being respawned.
A command that exits cannot also keep serving the review surface, so the serving half must live in a separate, longer-lived process.

The first `open` spawns a single **detached, persistent background server** (the daemon) bound to loopback on a fixed default port, started on demand.
The daemon **solely owns `SessionStore`**: path-based key derivation (`hash(realpath)`, see ADR 0001), the `open` status machine, the in-process `SynchronizedRef` that holds session state, and persistence to the single state file.
The CLI resolves the artifact's `realpath` and then acts purely as an HTTP client: ensure a healthy daemon exists (spawning it if absent), `POST` the path, open the browser tab, print the Session as TOON.

Because there is exactly one writer, "atomic read-modify-write so concurrent requests cannot corrupt state" is realized **in-process** with a `SynchronizedRef` (its internal mutex serializes derive-key + insert + persist), not with cross-process file locks.

## Considered options

- **Daemon owns state, CLI is a thin HTTP client** - chosen: single writer, so atomicity is an in-process `SynchronizedRef` with no cross-process locking; one code path reaches state; satisfies exit-0 plus a server shared across invocations and adopted on respawn.
- **CLI and daemon both write the state file** - rejected: two writers race one file, forcing cross-process locking / atomic temp-rename on every mutation and duplicating store logic in both processes.
- **No daemon; an ephemeral in-process server per invocation** - rejected: cannot satisfy "shared across invocations", "exits 0", or "a respawned server adopts existing sessions"; `open` would have to block to keep serving.

## Consequences

- A bare `intervu open` silently spawns a long-lived background process (it self-spawns `intervu server` detached and `unref`-ed). This is surprising and must stay documented.
- State persists as a single versioned state file under a per-user state directory (`$INTERVU_STATE_DIR`, else `$XDG_STATE_HOME/intervu`, else `~/.local/state/intervu`); the daemon loads it on startup so a respawn adopts existing Sessions.
- `SessionStore` depends on a thin `SessionPersistence` port (file layer vs in-memory layer) so the store logic is tested against an in-memory layer with no filesystem touched.
- Full lifecycle hardening (idle self-shutdown, stale-version takeover) is deferred to a later slice; until then the daemon runs until SIGTERM, which the minimal `stop` delivers by reading a pidfile.
- The per-Session queue of pending Feedback (#6) lives only in the daemon's in-process state, never in the persisted state file: a DOM snapshot is large and transient, and the durability guarantee ("queued feedback survives the poll being killed or timing out") is met by the daemon being the single long-lived owner, not by disk. A daemon restart drops undrained Feedback, which the human re-sends.
