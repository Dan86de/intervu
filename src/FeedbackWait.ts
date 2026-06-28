import { Duration, Effect, Option, PubSub, Ref } from "effect";
import type { Feedback } from "./Protocol.ts";
import type { SessionKey } from "./Session.ts";
import { SessionHub } from "./SessionHub.ts";
import { SessionStore } from "./SessionStore.ts";

const isEnded = (
  session: Option.Option<{ readonly status: string }>,
): boolean =>
  Option.match(session, {
    onNone: () => false,
    onSome: (s) => s.status === "ended",
  });

/**
 * The `poll` long-poll primitive (ADR 0009). A single suspended wait that drains
 * a key's queued Feedback exactly once, blocking silently until the human sends
 * - never busy-waiting. It subscribes to `SessionHub` and then, on each settle,
 * reads the Session status and drains `takeFeedback` (subscribe-then-check,
 * closing the queue-before-subscribe race), waking on a `FeedbackQueued` *or* a
 * `SessionEnded` signal. An internal heartbeat tick keeps the wait alive without
 * resolving it; on loopback it has no wire role (the daemon is loopback-only, so
 * a dead client delivers FIN/RST and the request scope interrupts this fiber),
 * so it is purely the merge element the unit test pins. Cleanup of the hub
 * subscription rides that scope, supplied by the caller's `Effect.scoped`.
 *
 * The settle has three reasons (ADR 0011): drained feedback, a bounded
 * `timedOut`, or the Session `ended`. `ended` is *not* mutually exclusive with
 * feedback - a Send & end commits the final feedback and the status flip to the
 * store before signalling, so one settle returns both. A poll that starts on an
 * already-`ended` Session returns `ended` immediately rather than blocking.
 */

/** The heartbeat interval merged into the wait; overridable for tests. */
export const DEFAULT_HEARTBEAT = Duration.seconds(20);

/**
 * What a settled poll returns (ADR 0009 / 0011): the drained feedback (possibly
 * empty), whether the bounded timeout fired, and whether the Session ended.
 * `ended` may co-occur with a non-empty `feedback` (Send & end).
 */
export interface PollOutcome {
  readonly timedOut: boolean;
  readonly ended: boolean;
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

  // The wake-signals are `FeedbackQueued` and `SessionEnded`; the hub also
  // carries presence and conversation frames, which must not spuriously re-drain
  // the poll. Take until a wake-signal, ignoring every other variant.
  const awaitWake: Effect.Effect<void> = PubSub.take(subscription).pipe(
    Effect.flatMap((event) =>
      event._tag === "FeedbackQueued" || event._tag === "SessionEnded"
        ? Effect.void
        : awaitWake,
    ),
  );

  const found: Effect.Effect<PollOutcome> = Effect.gen(function* () {
    while (true) {
      // Drain feedback and read the status in the same settle: a Send & end
      // commits both before signalling, so this returns the final feedback and
      // `ended` together (ADR 0011); the store, not the signal, is the truth.
      const drained = yield* store.takeFeedback(key);
      const ended = isEnded(yield* store.get(key));
      if (drained.length > 0) {
        yield* Ref.set(delivered, true);
        return { timedOut: false, ended, feedback: drained };
      }
      if (ended) {
        return { timedOut: false, ended: true, feedback: [] };
      }
      // A tick re-loops and re-drains (still empty), so it keeps the wait alive
      // without resolving it; a signal wins the race and re-settles. The
      // subscription buffers across the interrupt, so a tick never drops one.
      yield* Effect.race(awaitWake, Effect.sleep(heartbeat));
    }
  });

  return yield* Option.match(timeout, {
    onNone: () => found,
    onSome: (duration) =>
      found.pipe(
        Effect.timeoutOrElse({
          duration,
          orElse: (): Effect.Effect<PollOutcome> =>
            Effect.succeed({ timedOut: true, ended: false, feedback: [] }),
        }),
      ),
  });
});
