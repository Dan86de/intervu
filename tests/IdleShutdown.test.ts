import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import * as IdleShutdown from "../src/IdleShutdown.ts";

/**
 * `IdleShutdown.watch` driven over a `SubscriptionRef`-backed gauge with
 * `TestClock` pinning the grace window (ADR 0016). The watcher completes (which,
 * in the daemon, interrupts `Layer.launch` and tears it down) only after the
 * live-connection count has stayed zero for a whole grace window; a connection
 * arriving mid-window resets the timer. The watcher is forked and the clock is
 * advanced to settle each case; `SubscriptionRef.changes` replays the current
 * value, so the watcher arms on the count it finds.
 */
const GRACE = Duration.seconds(30);

describe("IdleShutdown.watch", () => {
  it.effect("shuts down once connections stay zero for the grace window", () =>
    Effect.gen(function* () {
      // Start connected so the first adjust lets the watcher subscribe; the
      // grace timer is then armed by the transition to zero below.
      const connections = yield* SubscriptionRef.make(1);
      const fiber = yield* IdleShutdown.watch(
        SubscriptionRef.changes(connections),
        GRACE,
      ).pipe(Effect.forkChild);

      // While a connection is held, no grace timer runs.
      yield* TestClock.adjust("30 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();

      // The last connection closes; just short of the window it still watches.
      yield* SubscriptionRef.set(connections, 0);
      yield* TestClock.adjust("29 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();

      // The full window elapses at zero: the watcher completes (shutdown).
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
    }),
  );

  it.effect("a connection arriving before the grace resets the timer", () =>
    Effect.gen(function* () {
      const connections = yield* SubscriptionRef.make(0);
      const fiber = yield* IdleShutdown.watch(
        SubscriptionRef.changes(connections),
        GRACE,
      ).pipe(Effect.forkChild);

      // Mid-window a connection opens: the pending grace timer is interrupted.
      yield* TestClock.adjust("20 seconds");
      yield* SubscriptionRef.set(connections, 1);

      // Even past the original window, nothing has shut down.
      yield* TestClock.adjust("20 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();

      // The connection closes; a fresh full window then completes the watcher.
      yield* SubscriptionRef.set(connections, 0);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(fiber);
    }),
  );

  it.effect("stays alive while a connection is held open", () =>
    Effect.gen(function* () {
      const connections = yield* SubscriptionRef.make(1);
      const fiber = yield* IdleShutdown.watch(
        SubscriptionRef.changes(connections),
        GRACE,
      ).pipe(Effect.forkChild);

      // No grace timer runs while the count is non-zero, however long passes.
      yield* TestClock.adjust("120 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* Fiber.interrupt(fiber);
    }),
  );
});
