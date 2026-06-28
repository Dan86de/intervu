import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import * as FeedbackWait from "../src/FeedbackWait.ts";
import { Feedback } from "../src/Protocol.ts";
import { SessionKey } from "../src/Session.ts";
import { FeedbackQueued, SessionHub } from "../src/SessionHub.ts";
import { SessionPersistence } from "../src/SessionPersistence.ts";
import { SessionStore } from "../src/SessionStore.ts";

/**
 * `FeedbackWait` driven against the real `SessionHub` and `SessionStore` (the hub
 * is in-memory, the store on the memory persistence layer), with `TestClock`
 * pinning the heartbeat and timeout. The wait is forked and the test waits until
 * it has subscribed (so the initial empty drain is done and the fiber is
 * suspended) before acting, which isolates the signal/heartbeat/timeout paths.
 */

const testLayer = Layer.mergeAll(SessionHub.layer, SessionStore.layer).pipe(
  Layer.provideMerge(SessionPersistence.memoryLayer([])),
  Layer.provide(BunCrypto.layer),
);

const feedbackWith = (message: string): Feedback =>
  new Feedback({ message, annotations: [], domSnapshot: "<html></html>" });

/** Block until the forked wait has registered its hub subscription. */
const awaitSubscribed = (key: SessionKey) =>
  Effect.gen(function* () {
    const hub = yield* SessionHub;
    while ((yield* hub.subscribers(key)) < 1) {
      yield* Effect.yieldNow;
    }
  });

/** Block until the forked wait has entered its poll (presence is listening). */
const awaitListening = (key: SessionKey) =>
  Effect.gen(function* () {
    const hub = yield* SessionHub;
    while ((yield* hub.presence(key)) !== "listening") {
      yield* Effect.yieldNow;
    }
  });

describe("FeedbackWait.wait", () => {
  it.effect(
    "resolves with the queued feedback when a signal is published",
    () =>
      Effect.gen(function* () {
        const hub = yield* SessionHub;
        const store = yield* SessionStore;
        const key = SessionKey.make("wait-resolve");

        const fiber = yield* FeedbackWait.wait(key).pipe(Effect.forkChild);
        yield* awaitSubscribed(key);

        yield* store.queueFeedback(key, feedbackWith("hello"));
        yield* hub.publish(key, new FeedbackQueued());

        const outcome = yield* Fiber.join(fiber);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.feedback.map((feedback) => feedback.message)).toEqual([
          "hello",
        ]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("a heartbeat tick keeps the wait alive without resolving it", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const store = yield* SessionStore;
      const key = SessionKey.make("wait-heartbeat");

      const fiber = yield* FeedbackWait.wait(key, {
        heartbeat: Duration.seconds(10),
      }).pipe(Effect.forkChild);
      yield* awaitSubscribed(key);

      // One heartbeat elapses: the wait re-drains (empty) and re-suspends.
      yield* TestClock.adjust("10 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();

      // A later publish still resolves it - the subscription survived the tick.
      yield* store.queueFeedback(key, feedbackWith("late"));
      yield* hub.publish(key, new FeedbackQueued());
      const outcome = yield* Fiber.join(fiber);
      expect(outcome.feedback.map((feedback) => feedback.message)).toEqual([
        "late",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("a bounded timeout returns timedOut, not feedback", () =>
    Effect.gen(function* () {
      const key = SessionKey.make("wait-timeout");

      const fiber = yield* FeedbackWait.wait(key, {
        timeout: Option.some(Duration.seconds(30)),
        heartbeat: Duration.seconds(60),
      }).pipe(Effect.forkChild);
      yield* awaitSubscribed(key);

      yield* TestClock.adjust("30 seconds");
      const outcome = yield* Fiber.join(fiber);
      expect(outcome.timedOut).toBe(true);
      expect(outcome.feedback).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("presence is listening while open, working after delivery", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const store = yield* SessionStore;
      const key = SessionKey.make("presence-deliver");

      const fiber = yield* Effect.scoped(FeedbackWait.wait(key)).pipe(
        Effect.forkChild,
      );
      yield* awaitListening(key);

      yield* store.queueFeedback(key, feedbackWith("hi"));
      yield* hub.publish(key, new FeedbackQueued());

      const outcome = yield* Fiber.join(fiber);
      expect(outcome.feedback).toHaveLength(1);
      // The scope closed on completion, so the exit finalizer recorded a
      // delivery: the agent took feedback and is now working.
      expect(yield* hub.presence(key)).toBe("working");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("a bounded timeout closes presence to idle, not working", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const key = SessionKey.make("presence-timeout");

      const fiber = yield* Effect.scoped(
        FeedbackWait.wait(key, {
          timeout: Option.some(Duration.seconds(30)),
          heartbeat: Duration.seconds(60),
        }),
      ).pipe(Effect.forkChild);
      yield* awaitListening(key);

      yield* TestClock.adjust("30 seconds");
      const outcome = yield* Fiber.join(fiber);
      expect(outcome.timedOut).toBe(true);
      expect(yield* hub.presence(key)).toBe("idle");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("a killed poll closes presence to idle", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const key = SessionKey.make("presence-kill");

      const fiber = yield* Effect.scoped(FeedbackWait.wait(key)).pipe(
        Effect.forkChild,
      );
      yield* awaitListening(key);

      yield* Fiber.interrupt(fiber);
      expect(yield* hub.presence(key)).toBe("idle");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("a dropped poll releases its hub subscription", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const key = SessionKey.make("wait-cleanup");

      // Effect.scoped ties the subscription to this fiber; interrupting it runs
      // the scope finalizer that unsubscribes.
      const fiber = yield* Effect.scoped(FeedbackWait.wait(key)).pipe(
        Effect.forkChild,
      );
      yield* awaitSubscribed(key);
      expect(yield* hub.subscribers(key)).toBe(1);

      yield* Fiber.interrupt(fiber);
      expect(yield* hub.subscribers(key)).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );
});
