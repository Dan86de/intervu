import {
  Crypto,
  Effect,
  Layer,
  Option,
  type PlatformError,
  type Schema,
  SynchronizedRef,
} from "effect";
import * as Context from "effect/Context";
import { Session, SessionKey } from "./Session.ts";
import { SessionPersistence } from "./SessionPersistence.ts";

type StoreError = PlatformError.PlatformError | Schema.SchemaError;

/**
 * The daemon's sole owner of session state (ADR 0002). Holds the session set in
 * a `SynchronizedRef` whose internal mutex serialises derive-key -> insert ->
 * persist, so concurrent `open` requests cannot corrupt state without any
 * cross-process locking. Loads the persisted set at construction, so a freshly
 * respawned daemon adopts existing Sessions.
 */
export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly open: (path: string) => Effect.Effect<Session, StoreError>;
    readonly get: (key: SessionKey) => Effect.Effect<Option.Option<Session>>;
    readonly list: Effect.Effect<readonly Session[]>;
  }
>()("@intervu/SessionStore") {
  static readonly layer = Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const persistence = yield* SessionPersistence;
      const ref = yield* SynchronizedRef.make(yield* persistence.load);

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

      const list = SynchronizedRef.get(ref);

      return { open, get, list };
    }),
  );
}
