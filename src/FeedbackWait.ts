import { Duration, Effect, Option, PubSub, Ref } from "effect";
import type { Feedback } from "./Protocol.ts";
import type { SessionKey } from "./Session.ts";
import { SessionHub } from "./SessionHub.ts";
import { SessionStore } from "./SessionStore.ts";

/**
 * The `poll` long-poll primitive (ADR 0009). A single suspended wait that drains
 * a key's queued Feedback exactly once, blocking silently until the human sends
 * - never busy-waiting. It subscribes to `SessionHub` and then drains
 * `takeFeedback`, closing the queue-before-subscribe race, and re-drains on
 * every `FeedbackQueued` signal. An internal heartbeat tick keeps the wait alive
 * without resolving it; on loopback it has no wire role (the daemon is
 * loopback-only, so a dead client delivers FIN/RST and the request scope
 * interrupts this fiber), so it is purely the merge element the unit test pins.
 * Cleanup of the hub subscription rides that scope, supplied by the caller's
 * `Effect.scoped`.
 */

/** The heartbeat interval merged into the wait; overridable for tests. */
export const DEFAULT_HEARTBEAT = Duration.seconds(20);

/** What a settled poll returns: drained feedback, or the bounded-timeout marker. */
export interface PollOutcome {
  readonly timedOut: boolean;
  readonly feedback: readonly Feedback[];
}

export const wait = Effect.fn("FeedbackWait.wait")(function* (
  key: SessionKey,
  options?: {
    readonly timeout?: Option.Option<Duration.Duration>;
    readonly heartbeat?: Duration.Duration;
  },
) {
  const hub = yield* SessionHub;
  const store = yield* SessionStore;
  const heartbeat = options?.heartbeat ?? DEFAULT_HEARTBEAT;
  const timeout = options?.timeout ?? Option.none();

  // Presence (ADR 0010): an open poll is "listening"; on close, a delivery means
  // the agent took feedback ("working"), while a timeout or a killed poll closes
  // without delivery and falls to "idle". The finalizer rides the caller's scope,
  // so Bun's request-abort on a killed poll still records the exit. It is
  // registered before `subscribe`, so on teardown it runs after the subscription
  // is torn down (LIFO): `exitPoll` publishes a `PresenceChanged`, and publishing
  // while this poll's own subscription still holds an interrupted poller is unsafe.
  const delivered = yield* Ref.make(false);
  yield* Effect.addFinalizer(() =>
    Ref.get(delivered).pipe(Effect.flatMap((d) => hub.exitPoll(key, d))),
  );

  // Subscribe before the first drain so a publish that races the drain still
  // wakes us (subscribe-then-drain).
  const subscription = yield* hub.subscribe(key);
  yield* hub.enterPoll(key);

  // The wake-signal is `FeedbackQueued` only; the hub now also carries presence
  // and conversation frames, which must not spuriously re-drain the poll. Take
  // until the queued signal, ignoring every other variant.
  const awaitQueued: Effect.Effect<void> = PubSub.take(subscription).pipe(
    Effect.flatMap((event) =>
      event._tag === "FeedbackQueued" ? Effect.void : awaitQueued,
    ),
  );

  const drainOrWait: Effect.Effect<readonly Feedback[]> = Effect.gen(
    function* () {
      while (true) {
        const drained = yield* store.takeFeedback(key);
        if (drained.length > 0) {
          yield* Ref.set(delivered, true);
          return drained;
        }
        // A tick re-loops and re-drains (still empty), so it keeps the wait
        // alive without resolving it; a signal wins the race and re-drains to
        // the queued Feedback. The subscription buffers across the interrupt,
        // so a tick never drops a signal.
        yield* Effect.race(awaitQueued, Effect.sleep(heartbeat));
      }
    },
  );

  const found = drainOrWait.pipe(
    Effect.map((feedback): PollOutcome => ({ timedOut: false, feedback })),
  );

  return yield* Option.match(timeout, {
    onNone: () => found,
    onSome: (duration) =>
      found.pipe(
        Effect.timeoutOrElse({
          duration,
          orElse: (): Effect.Effect<PollOutcome> =>
            Effect.succeed({ timedOut: true, feedback: [] }),
        }),
      ),
  });
});
