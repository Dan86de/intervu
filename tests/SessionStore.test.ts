import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { Feedback } from "../src/Protocol.ts";
import { Session, SessionKey } from "../src/Session.ts";
import { SessionPersistence } from "../src/SessionPersistence.ts";
import { SessionStore } from "../src/SessionStore.ts";

const feedbackWith = (message: string): Feedback =>
  new Feedback({ message, annotations: [], domSnapshot: "<html></html>" });

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

  it.effect(
    "queueFeedback then takeFeedback drains in order, exactly once",
    () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const session = yield* store.open("/tmp/a.html");

        yield* store.queueFeedback(session.key, feedbackWith("first"));
        yield* store.queueFeedback(session.key, feedbackWith("second"));

        const drained = yield* store.takeFeedback(session.key);
        expect(drained.map((feedback) => feedback.message)).toEqual([
          "first",
          "second",
        ]);

        // Take-once: a second take after a drain is the definitive empty state.
        const again = yield* store.takeFeedback(session.key);
        expect(again).toHaveLength(0);
      }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("takeFeedback on a never-queued key is empty, not an error", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const session = yield* store.open("/tmp/a.html");

      const drained = yield* store.takeFeedback(session.key);
      expect(drained).toHaveLength(0);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("re-opening a path preserves its queued feedback", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const first = yield* store.open("/tmp/a.html");
      yield* store.queueFeedback(first.key, feedbackWith("queued"));

      // The idempotent reopen must not drop the in-flight queue.
      yield* store.open("/tmp/a.html");

      const drained = yield* store.takeFeedback(first.key);
      expect(drained.map((feedback) => feedback.message)).toEqual(["queued"]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("getByPath resolves the same Session as the derived key", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const opened = yield* store.open("/tmp/a.html");

      const found = yield* store.getByPath("/tmp/a.html");
      expect(Option.getOrUndefined(found)?.key).toBe(opened.key);

      const missing = yield* store.getByPath("/tmp/never.html");
      expect(Option.isSome(missing)).toBe(false);
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
