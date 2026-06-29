import { type Duration, Effect, Stream } from "effect";

/**
 * The daemon's idle self-shutdown watcher (ADR 0016). It observes the global
 * live-connection gauge (open polls plus open SSE streams, tracked at the single
 * `SessionHub.subscribe` seam) and completes once that count has stayed zero for
 * a whole grace window - at which point the `server` command, which races this
 * against `Layer.launch`, lets the watcher win and tears the daemon down.
 *
 * `connections` replays its current value on subscribe (`SubscriptionRef.changes`
 * is `replay: 1`), so the watcher arms immediately at startup with the count it
 * finds. `switchMap` restarts the inner grace timer on every transition: while
 * the count is zero the inner stream sleeps for the grace window and then emits;
 * any non-zero value switches to `Stream.never`, interrupting the pending sleep,
 * and a return to zero starts a fresh full window. `take(1)` therefore fires
 * only after the count has been continuously zero for the entire grace - so a
 * connection that arrives during the spawn->first-connect startup window (or any
 * later gap) resets the timer rather than racing a shutdown.
 *
 * It is a standalone mechanism over a plain `Stream<number>` (not over
 * `SessionHub` directly) so it requires nothing and tests drive it with their
 * own `SubscriptionRef`; the `server` command passes `hub.connectionChanges`.
 * The grace is injected (default `AppConfig.idleTimeout`) so a TestClock can pin
 * it. The watcher does not end sessions: persisted `open` sessions survive the
 * daemon's death and a re-run of `intervu <file>` respawns and resumes them.
 */
export const watch = (
  connections: Stream.Stream<number>,
  grace: Duration.Duration,
): Effect.Effect<void> =>
  connections.pipe(
    Stream.switchMap((count) =>
      count === 0 ? Stream.fromEffect(Effect.sleep(grace)) : Stream.never,
    ),
    Stream.take(1),
    Stream.runDrain,
  );
