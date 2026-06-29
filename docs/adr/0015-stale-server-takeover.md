# Stale-server takeover via version-gated pidfile SIGTERM

When a client finds a daemon already answering `GET /health`, it compares the reported version against its own and takes over **iff the running version is strictly older**: it SIGTERMs the daemon via the shared `<stateDir>/server.pid`, waits for the port to free (poll `/health` until connection-refused), then spawns its own and waits healthy.
An equal-or-newer daemon is reused untouched - the older client "steps aside", so the only client that ever replaces a server is a strictly-newer one.
Versions are compared as numeric `major.minor.patch` tuples (no `semver` dependency; an unparseable running version counts as stale).

We evict via the pidfile + signal, **not** an HTTP shutdown route, because the stale server is by definition an *older* version that cannot be assumed to expose any new endpoint - whereas every version writes the same pidfile and shuts down gracefully on SIGTERM, so the signal is the one channel that works across the version gap the feature exists to bridge.
The signal core is shared with `intervu stop` (`ServerLifecycle.signalStop`).

The *actual* takeover lives only on the `open` path (`ensure`).
The `poll`/`end` path (`requireHealthy`) is a pure spawn-free client per ADR 0009, so it does not take over inline; instead it runs the **same version predicate** and, on a strictly-older daemon, fails with a structured `StaleDaemon` error that redirects the agent to re-run `intervu <file>` (which performs the takeover) before polling again.
So the predicate is shared and the response differs by path: `ensure` detects and *acts*, `requireHealthy` detects and *redirects* - and the agent never talks to old code on either path (story #27).

## Considered options

- **HTTP `POST /stop` shutdown endpoint** - rejected: it only helps newer->newer takeovers and would still need the SIGTERM path for the cross-version case, so it is extra surface for no real gain.
- **Real semver ordering (a dependency)** - deferred: the version is a controlled `0.0.0`-shaped string, so a numeric tuple comparison suffices for the MVP; pre-release/build suffixes are ignored.
- **Taking over inline on `poll`/`end`** - rejected: it puts a slow, fail-able operation (SIGTERM -> wait -> spawn -> wait-healthy) on the defensive long-poll hot path and breaks ADR 0009's spawn-free guarantee. Those paths refuse-and-redirect (`StaleDaemon`) instead.

## Consequences

- A takeover, like any daemon death, drops the in-memory queues and Conversation (ADR 0002); the respawned daemon adopts the persisted sessions. Acceptable because takeover is an upgrade-time event.
- If a server answers `/health` with an old version but the pidfile is missing, garbage, or names a dead process, the takeover cannot proceed and fails with a structured `StaleServerTakeover` (telling the human to `intervu stop` or kill it manually) rather than spawning into an occupied port.
