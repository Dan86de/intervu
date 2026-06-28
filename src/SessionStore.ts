import {
  Crypto,
  Effect,
  Layer,
  Option,
  type PlatformError,
  Ref,
  type Schema,
  SynchronizedRef,
} from "effect";
import * as Context from "effect/Context";
import { ConversationEntry, type Feedback, type Role } from "./Protocol.ts";
import { Session, SessionKey } from "./Session.ts";
import { SessionPersistence } from "./SessionPersistence.ts";

type StoreError = PlatformError.PlatformError | Schema.SchemaError;

/**
 * The daemon's sole owner of session state (ADR 0002). Holds the session set in
 * a `SynchronizedRef` whose internal mutex serialises derive-key -> insert ->
 * persist, so concurrent `open` requests cannot corrupt state without any
 * cross-process locking. Loads the persisted set at construction, so a freshly
 * respawned daemon adopts existing Sessions.
 *
 * Each Session's queue of pending Feedback lives in a separate in-memory `Ref`,
 * never in the persisted state file (ADR 0002): snapshots are large and
 * transient, and durability across a killed poll is met by the daemon being the
 * single long-lived owner. `takeFeedback` drains a key's queue exactly once and
 * is the single source of truth for what a poll returns (ADR 0009).
 *
 * Beside the queues lives the per-key Conversation (ADR 0010): the daemon-owned,
 * in-memory ordered thread of the human's Feedback messages and the agent's
 * Agent-replies, each entry carrying a monotonic `seq`. It is the single source
 * of truth the SSE route replays on connect and appends to live; like the
 * queues it is transient and never persisted.
 */
export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly open: (path: string) => Effect.Effect<Session, StoreError>;
    readonly get: (key: SessionKey) => Effect.Effect<Option.Option<Session>>;
    readonly getByPath: (
      path: string,
    ) => Effect.Effect<Option.Option<Session>, StoreError>;
    readonly list: Effect.Effect<readonly Session[]>;
    readonly queueFeedback: (
      key: SessionKey,
      feedback: Feedback,
    ) => Effect.Effect<void>;
    readonly takeFeedback: (
      key: SessionKey,
    ) => Effect.Effect<readonly Feedback[]>;
    readonly appendConversation: (
      key: SessionKey,
      entry: {
        readonly role: Role;
        readonly text: string;
        readonly annotationCount: number;
      },
    ) => Effect.Effect<ConversationEntry>;
    readonly conversationSince: (
      key: SessionKey,
      afterSeq: number,
    ) => Effect.Effect<readonly ConversationEntry[]>;
  }
>()("@intervu/SessionStore") {
  static readonly layer = Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const persistence = yield* SessionPersistence;
      const ref = yield* SynchronizedRef.make(yield* persistence.load);
      const queues = yield* Ref.make(
        new Map<SessionKey, readonly Feedback[]>(),
      );
      const conversations = yield* Ref.make(
        new Map<SessionKey, readonly ConversationEntry[]>(),
      );

      /** Path-based key: SHA-256 hex of the realpath, truncated to 16 (ADR 0001). */
      const deriveKey = (path: string) =>
        Effect.gen(function* () {
          const digest = yield* crypto.digest(
            "SHA-256",
            new TextEncoder().encode(path),
          );
          const hex = Array.from(digest)
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 16);
          return SessionKey.make(hex);
        });

      const open = Effect.fn("SessionStore.open")(function* (path: string) {
        return yield* SynchronizedRef.modifyEffect(ref, (sessions) =>
          Effect.gen(function* () {
            const key = yield* deriveKey(path);
            const existing = sessions.find((session) => session.key === key);
            if (existing !== undefined) {
              // Idempotent re-open: resume the Session, no duplicate state.
              return [existing, sessions] as const;
            }
            const session = new Session({ key, path, status: "open" });
            const next = [...sessions, session];
            yield* persistence.save(next);
            return [session, next] as const;
          }),
        );
      });

      const get = Effect.fn("SessionStore.get")(function* (key: SessionKey) {
        const sessions = yield* SynchronizedRef.get(ref);
        return Option.fromNullishOr(
          sessions.find((session) => session.key === key),
        );
      });

      const getByPath = Effect.fn("SessionStore.getByPath")(function* (
        path: string,
      ) {
        const key = yield* deriveKey(path);
        return yield* get(key);
      });

      const list = SynchronizedRef.get(ref);

      const queueFeedback = Effect.fn("SessionStore.queueFeedback")(function* (
        key: SessionKey,
        feedback: Feedback,
      ) {
        yield* Ref.update(queues, (map) => {
          const next = new Map(map);
          next.set(key, [...(map.get(key) ?? []), feedback]);
          return next;
        });
      });

      // Atomic drain-once: read the key's queue and clear it in a single
      // `Ref.modify`, so two concurrent polls can never return the same
      // Feedback twice (ADR 0009).
      const takeFeedback = Effect.fn("SessionStore.takeFeedback")(function* (
        key: SessionKey,
      ) {
        return yield* Ref.modify(queues, (map) => {
          const drained = map.get(key) ?? [];
          if (drained.length === 0) {
            return [drained, map] as const;
          }
          const next = new Map(map);
          next.delete(key);
          return [drained, next] as const;
        });
      });

      // Append one Conversation entry and stamp it with the next `seq` for the
      // key (1-based, monotonic, gap-free since nothing is ever removed), so the
      // returned entry is exactly what the SSE route frames with `id: <seq>`.
      const appendConversation = Effect.fn("SessionStore.appendConversation")(
        function* (
          key: SessionKey,
          entry: {
            readonly role: Role;
            readonly text: string;
            readonly annotationCount: number;
          },
        ) {
          return yield* Ref.modify(conversations, (map) => {
            const existing = map.get(key) ?? [];
            const appended = new ConversationEntry({
              seq: existing.length + 1,
              role: entry.role,
              text: entry.text,
              annotationCount: entry.annotationCount,
            });
            const next = new Map(map);
            next.set(key, [...existing, appended]);
            return [appended, next] as const;
          });
        },
      );

      // The replay slice for an SSE (re)connect: every entry newer than the
      // client's `Last-Event-ID` (0 on a first connect). `EventSource` reconnects
      // without clearing the thread, so replaying only newer entries never dupes.
      const conversationSince = Effect.fn("SessionStore.conversationSince")(
        function* (key: SessionKey, afterSeq: number) {
          const map = yield* Ref.get(conversations);
          return (map.get(key) ?? []).filter((entry) => entry.seq > afterSeq);
        },
      );

      return {
        open,
        get,
        getByPath,
        list,
        queueFeedback,
        takeFeedback,
        appendConversation,
        conversationSince,
      };
    }),
  );
}
