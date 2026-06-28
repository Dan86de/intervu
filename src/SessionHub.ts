import {
  Effect,
  Layer,
  PubSub,
  Ref,
  Schema,
  type Scope,
  SynchronizedRef,
} from "effect";
import * as Context from "effect/Context";
import type { SessionKey } from "./Session.ts";

/**
 * The daemon's per-key publish/subscribe surface (issue #6; ADR 0009). It
 * carries a wake-signal only - never a Feedback payload: `takeFeedback` in the
 * `SessionStore` stays the single source of truth, and the hub just nudges a
 * waiting poll to re-drain. The event is a one-variant tagged union for now;
 * #7 widens it for reload / agent-reply / presence.
 */

/** The only hub event this slice: feedback was queued for a key, go re-drain. */
export class FeedbackQueued extends Schema.TaggedClass<FeedbackQueued>(
  "FeedbackQueued",
)("FeedbackQueued", {}) {}

/** Every signal the hub can carry; one variant this slice, widened in #7. */
export const HubEvent = Schema.Union([FeedbackQueued]);
export type HubEvent = typeof HubEvent.Type;

/**
 * A per-key `PubSub` of hub events, created lazily on first publish/subscribe
 * and held in a `SynchronizedRef` whose mutex serialises get-or-create so two
 * concurrent callers share one hub. A per-key subscriber count (tracked by the
 * subscribe scope's finalizer) backs the long-poll cleanup test now and
 * presence later (#7).
 */
export class SessionHub extends Context.Service<
  SessionHub,
  {
    readonly publish: (key: SessionKey, event: HubEvent) => Effect.Effect<void>;
    readonly subscribe: (
      key: SessionKey,
    ) => Effect.Effect<PubSub.Subscription<HubEvent>, never, Scope.Scope>;
    readonly subscribers: (key: SessionKey) => Effect.Effect<number>;
  }
>()("@intervu/SessionHub") {
  static readonly layer = Layer.effect(
    SessionHub,
    Effect.gen(function* () {
      const hubs = yield* SynchronizedRef.make(
        new Map<SessionKey, PubSub.PubSub<HubEvent>>(),
      );
      const counts = yield* Ref.make(new Map<SessionKey, number>());

      const bump =
        (key: SessionKey, delta: number) => (map: Map<SessionKey, number>) => {
          const next = new Map(map);
          next.set(key, (map.get(key) ?? 0) + delta);
          return next;
        };

      const hubFor = (key: SessionKey) =>
        SynchronizedRef.modifyEffect(hubs, (map) =>
          Effect.gen(function* () {
            const existing = map.get(key);
            if (existing !== undefined) {
              return [existing, map] as const;
            }
            const created = yield* PubSub.unbounded<HubEvent>();
            const next = new Map(map);
            next.set(key, created);
            return [created, next] as const;
          }),
        );

      const publish = (key: SessionKey, event: HubEvent): Effect.Effect<void> =>
        hubFor(key).pipe(Effect.flatMap((hub) => PubSub.publish(hub, event)));

      const subscribe = (key: SessionKey) =>
        hubFor(key).pipe(
          Effect.flatMap((hub) =>
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(hub);
              yield* Ref.update(counts, bump(key, 1));
              yield* Effect.addFinalizer(() =>
                Ref.update(counts, bump(key, -1)),
              );
              return subscription;
            }),
          ),
        );

      const subscribers = (key: SessionKey): Effect.Effect<number> =>
        Ref.get(counts).pipe(Effect.map((map) => map.get(key) ?? 0));

      return { publish, subscribe, subscribers };
    }),
  );
}
