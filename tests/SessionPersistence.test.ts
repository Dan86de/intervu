import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Session, SessionKey } from "../src/Session.ts";
import { SessionPersistence } from "../src/SessionPersistence.ts";

/** The in-memory persistence layer used by the store tests, exercised directly. */

const sessionAt = (key: string, path: string) =>
  new Session({ key: SessionKey.make(key), path, status: "open" });

describe("SessionPersistence.memoryLayer", () => {
  it.effect("round-trips the saved session set", () =>
    Effect.gen(function* () {
      const persistence = yield* SessionPersistence;
      const session = sessionAt("abc0000000000000", "/tmp/a.html");

      yield* persistence.save([session]);
      const loaded = yield* persistence.load;

      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.key).toBe(session.key);
      expect(loaded[0]?.path).toBe("/tmp/a.html");
    }).pipe(Effect.provide(SessionPersistence.memoryLayer())),
  );

  it.effect("loads the seeded set", () =>
    Effect.gen(function* () {
      const persistence = yield* SessionPersistence;
      const loaded = yield* persistence.load;
      expect(loaded).toHaveLength(1);
    }).pipe(
      Effect.provide(
        SessionPersistence.memoryLayer([
          sessionAt("seedkey000000000", "/s.html"),
        ]),
      ),
    ),
  );
});
