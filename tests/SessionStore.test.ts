import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { Session, SessionKey } from "../src/Session.ts";
import { SessionPersistence } from "../src/SessionPersistence.ts";
import { SessionStore } from "../src/SessionStore.ts";

/**
 * SessionStore exercised against the in-memory `SessionPersistence` layer, with
 * real `BunCrypto` for deterministic key derivation. No filesystem is touched.
 */

const storeLayer = (seed: readonly Session[] = []) =>
  SessionStore.layer.pipe(
    Layer.provideMerge(SessionPersistence.memoryLayer(seed)),
    Layer.provide(BunCrypto.layer),
  );

describe("SessionStore", () => {
  it.effect("open returns a Session that get and list reflect", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;

      const session = yield* store.open("/tmp/a.html");
      expect(session.path).toBe("/tmp/a.html");
      expect(session.status).toBe("open");

      const all = yield* store.list;
      expect(all).toHaveLength(1);

      const found = yield* store.get(session.key);
      expect(Option.getOrUndefined(found)?.key).toBe(session.key);

      const missing = yield* store.get(SessionKey.make("ffffffffffffffff"));
      expect(Option.isSome(missing)).toBe(false);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("derives a stable 16-char hex key from the path", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;

      const first = yield* store.open("/tmp/a.html");
      const again = yield* store.open("/tmp/a.html");
      const other = yield* store.open("/tmp/b.html");

      expect(first.key).toBe(again.key);
      expect(first.key).not.toBe(other.key);
      expect(first.key).toMatch(/^[0-9a-f]{16}$/);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("re-opening the same path resumes one Session", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;

      const first = yield* store.open("/tmp/a.html");
      const second = yield* store.open("/tmp/a.html");

      expect(second.key).toBe(first.key);
      const all = yield* store.list;
      expect(all).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("persists opened Sessions through the port", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const session = yield* store.open("/tmp/a.html");

      const persistence = yield* SessionPersistence;
      const persisted = yield* persistence.load;

      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.key).toBe(session.key);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a fresh store adopts persisted Sessions on startup", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const all = yield* store.list;

      expect(all).toHaveLength(1);
      expect(all[0]?.path).toBe("/tmp/seed.html");
    }).pipe(
      Effect.provide(
        storeLayer([
          new Session({
            key: SessionKey.make("seedkey000000000"),
            path: "/tmp/seed.html",
            status: "open",
          }),
        ]),
      ),
    ),
  );
});
