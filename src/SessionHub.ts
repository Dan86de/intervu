import {
  Effect,
  Layer,
  PubSub,
  Ref,
  Schema,
  type Scope,
  type Stream,
  SubscriptionRef,
  SynchronizedRef,
} from "effect";
import * as Context from "effect/Context";
import { ConversationEntry, Presence } from "./Protocol.ts";
import type { SessionKey } from "./Session.ts";

/**
 * The daemon's per-key publish/subscribe surface (issues #6, #7; ADR 0009 /
 * 0010). One hub multiplexes every server-driven signal: the poll's wake-signal
 * and the three browser-facing pushes. The poll and the SSE route subscribe to
 * the same per-key hub and each filter by tag, so `FeedbackQueued` stays the
 * poll's wake-signal only and never reaches the browser, while reload / reply /
 * presence frames never spuriously re-drain the poll.
 *
 * Presence (#7) lives here too: an `openPollCount` plus `lastCloseWasDelivery`,
 * mutated at the poll's `enterPoll` / `exitPoll` seams and pushed as
 * `PresenceChanged`. It is deliberately separate from `subscribers` (event
 * subscriptions, which both the poll and a browser SSE connection hold), so a
 * browser connection never counts as an agent poll.
 */

/** The poll's wake-signal: feedback was queued for a key, go re-drain. Empty. */
export class FeedbackQueued extends Schema.TaggedClass<FeedbackQueued>(
  "FeedbackQueued",
)("FeedbackQueued", {}) {}

/** One Conversation entry was appended (the human's message or an Agent-reply). */
export class ConversationAppended extends Schema.TaggedClass<ConversationAppended>(
  "ConversationAppended",
)("ConversationAppended", {
  entry: ConversationEntry,
}) {}

/** The artifact file changed on disk: nudge the browser to reload the iframe. */
export class ArtifactReloaded extends Schema.TaggedClass<ArtifactReloaded>(
  "ArtifactReloaded",
)("ArtifactReloaded", {}) {}

/** The agent's Presence changed; carries the freshly derived current state. */
export class PresenceChanged extends Schema.TaggedClass<PresenceChanged>(
  "PresenceChanged",
)("PresenceChanged", {
  presence: Presence,
}) {}

/**
 * The Session ended (ADR 0011 / 0012). A payload-free wake-signal: a waiting
 * poll re-settles and reads the authoritative `ended` from `store.get(key)`,
 * exactly as `FeedbackQueued` carries no feedback. Unlike `FeedbackQueued`, it
 * *does* map to an SSE frame, so the chrome reacts to the ended state.
 */
export class SessionEnded extends Schema.TaggedClass<SessionEnded>(
  "SessionEnded",
)("SessionEnded", {}) {}

/** Every signal the hub can carry, discriminated on `_tag`. */
export const HubEvent = Schema.Union([
  FeedbackQueued,
  ConversationAppended,
  ArtifactReloaded,
  PresenceChanged,
  SessionEnded,
]);
export type HubEvent = typeof HubEvent.Type;

/** The per-key Presence inputs, folded to a state by `derivePresence`. */
interface PresenceState {
  readonly openPollCount: number;
  readonly lastCloseWasDelivery: boolean;
}

const initialPresence: PresenceState = {
  openPollCount: 0,
  lastCloseWasDelivery: false,
};

/**
 * Pure Presence derivation (CONTEXT.md "Presence"): an open poll means the agent
 * is `listening`; with none open, a poll that last closed on a delivery means the
 * agent took feedback and is `working`; otherwise `idle`. A bare timeout or a
 * killed poll closes without delivery, so it falls to `idle`, not `working`.
 */
export const derivePresence = (state: PresenceState): Presence =>
  state.openPollCount > 0
    ? "listening"
    : state.lastCloseWasDelivery
      ? "working"
      : "idle";

/**
 * A per-key `PubSub` of hub events, created lazily on first publish/subscribe
 * and held in a `SynchronizedRef` whose mutex serialises get-or-create so two
 * concurrent callers share one hub. A per-key subscriber count (tracked by the
 * subscribe scope's finalizer) backs the long-poll cleanup test and the SSE
 * route; a separate per-key Presence state backs the indicator.
 *
 * A single global live-connection gauge (`SubscriptionRef<number>`; ADR 0016)
 * is bumped at the same `subscribe` seam: every open poll and every open SSE
 * stream counts once, so the daemon is "idle" exactly when it reads zero. The
 * reactive `connectionChanges` stream drives `IdleShutdown`.
 */
export class SessionHub extends Context.Service<
  SessionHub,
  {
    readonly publish: (key: SessionKey, event: HubEvent) => Effect.Effect<void>;
    readonly subscribe: (
      key: SessionKey,
    ) => Effect.Effect<PubSub.Subscription<HubEvent>, never, Scope.Scope>;
    readonly subscribers: (key: SessionKey) => Effect.Effect<number>;
    readonly enterPoll: (key: SessionKey) => Effect.Effect<void>;
    readonly exitPoll: (
      key: SessionKey,
      wasDelivery: boolean,
    ) => Effect.Effect<void>;
    readonly presence: (key: SessionKey) => Effect.Effect<Presence>;
    readonly liveConnections: Effect.Effect<number>;
    readonly connectionChanges: Stream.Stream<number>;
  }
>()("@intervu/SessionHub") {
  static readonly layer = Layer.effect(
    SessionHub,
    Effect.gen(function* () {
      const hubs = yield* SynchronizedRef.make(
        new Map<SessionKey, PubSub.PubSub<HubEvent>>(),
      );
      const counts = yield* Ref.make(new Map<SessionKey, number>());
      const presences = yield* Ref.make(new Map<SessionKey, PresenceState>());
      const connections = yield* SubscriptionRef.make(0);

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

      // The single subscribe seam (ADR 0016): both the per-key subscriber count
      // and the global live-connection gauge move together here, and the scope
      // finalizer reverses both, so a killed poll or a closed SSE stream is
      // accounted for symmetrically.
      const subscribe = (key: SessionKey) =>
        hubFor(key).pipe(
          Effect.flatMap((hub) =>
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(hub);
              yield* Ref.update(counts, bump(key, 1));
              yield* SubscriptionRef.update(connections, (n) => n + 1);
              yield* Effect.addFinalizer(() =>
                Ref.update(counts, bump(key, -1)).pipe(
                  Effect.flatMap(() =>
                    SubscriptionRef.update(connections, (n) => n - 1),
                  ),
                ),
              );
              return subscription;
            }),
          ),
        );

      const subscribers = (key: SessionKey): Effect.Effect<number> =>
        Ref.get(counts).pipe(Effect.map((map) => map.get(key) ?? 0));

      const liveConnections = SubscriptionRef.get(connections);
      const connectionChanges = SubscriptionRef.changes(connections);

      const presence = (key: SessionKey): Effect.Effect<Presence> =>
        Ref.get(presences).pipe(
          Effect.map((map) => derivePresence(map.get(key) ?? initialPresence)),
        );

      // Mutate the Presence state and push the freshly derived value, so a
      // browser connected before or after the change converges on the same
      // indicator (presence is current-state, re-derived on every transition).
      const transition = (
        key: SessionKey,
        change: (state: PresenceState) => PresenceState,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const next = yield* Ref.modify(presences, (map) => {
            const updated = change(map.get(key) ?? initialPresence);
            const nextMap = new Map(map);
            nextMap.set(key, updated);
            return [updated, nextMap] as const;
          });
          yield* publish(
            key,
            new PresenceChanged({ presence: derivePresence(next) }),
          );
        });

      const enterPoll = (key: SessionKey): Effect.Effect<void> =>
        transition(key, (state) => ({
          ...state,
          openPollCount: state.openPollCount + 1,
        }));

      const exitPoll = (
        key: SessionKey,
        wasDelivery: boolean,
      ): Effect.Effect<void> =>
        transition(key, (state) => ({
          openPollCount: Math.max(0, state.openPollCount - 1),
          lastCloseWasDelivery: wasDelivery,
        }));

      return {
        publish,
        subscribe,
        subscribers,
        enterPoll,
        exitPoll,
        presence,
        liveConnections,
        connectionChanges,
      };
    }),
  );
}
