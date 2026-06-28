import { describe, expect, it } from "@effect/vitest";
import { Effect, PubSub } from "effect";
import { SessionKey } from "../src/Session.ts";
import { derivePresence, SessionHub } from "../src/SessionHub.ts";

/**
 * `SessionHub`'s Presence (ADR 0010): an open poll is `listening`; with none
 * open, a delivery close is `working` and a non-delivery close (timeout or kill)
 * is `idle`. The counter is multi-poll-safe and presence-neutral relative to
 * event subscriptions (a browser SSE connection must not count as an agent poll).
 */

describe("derivePresence", () => {
  it("an open poll is listening regardless of the last close", () => {
    expect(
      derivePresence({ openPollCount: 1, lastCloseWasDelivery: false }),
    ).toBe("listening");
    expect(
      derivePresence({ openPollCount: 2, lastCloseWasDelivery: true }),
    ).toBe("listening");
  });

  it("with no poll open, a delivery is working and anything else is idle", () => {
    expect(
      derivePresence({ openPollCount: 0, lastCloseWasDelivery: true }),
    ).toBe("working");
    expect(
      derivePresence({ openPollCount: 0, lastCloseWasDelivery: false }),
    ).toBe("idle");
  });
});

describe("SessionHub presence", () => {
  it.effect(
    "enter then a delivery close moves idle -> listening -> working",
    () =>
      Effect.gen(function* () {
        const hub = yield* SessionHub;
        const key = SessionKey.make("presence-flow");

        expect(yield* hub.presence(key)).toBe("idle");
        yield* hub.enterPoll(key);
        expect(yield* hub.presence(key)).toBe("listening");
        yield* hub.exitPoll(key, true);
        expect(yield* hub.presence(key)).toBe("working");
      }).pipe(Effect.provide(SessionHub.layer)),
  );

  it.effect("a non-delivery close drops to idle, not working", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const key = SessionKey.make("presence-idle");

      yield* hub.enterPoll(key);
      yield* hub.exitPoll(key, false);
      expect(yield* hub.presence(key)).toBe("idle");
    }).pipe(Effect.provide(SessionHub.layer)),
  );

  it.effect("stays listening while any poll is still open", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const key = SessionKey.make("presence-multi");

      yield* hub.enterPoll(key);
      yield* hub.enterPoll(key);
      yield* hub.exitPoll(key, true);
      expect(yield* hub.presence(key)).toBe("listening");
      yield* hub.exitPoll(key, false);
      expect(yield* hub.presence(key)).toBe("idle");
    }).pipe(Effect.provide(SessionHub.layer)),
  );

  it.effect("entering a poll publishes a PresenceChanged frame", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const key = SessionKey.make("presence-publish");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* hub.subscribe(key);
          yield* hub.enterPoll(key);
          const event = yield* PubSub.take(subscription);
          expect(event._tag).toBe("PresenceChanged");
          if (event._tag === "PresenceChanged") {
            expect(event.presence).toBe("listening");
          }
        }),
      );
    }).pipe(Effect.provide(SessionHub.layer)),
  );

  it.effect("a poll counter does not move the event-subscriber count", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const key = SessionKey.make("presence-neutral");

      yield* hub.enterPoll(key);
      expect(yield* hub.subscribers(key)).toBe(0);
      yield* hub.exitPoll(key, false);
      expect(yield* hub.subscribers(key)).toBe(0);
    }).pipe(Effect.provide(SessionHub.layer)),
  );
});
