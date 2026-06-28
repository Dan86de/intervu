import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as Toon from "../src/Toon.ts";

describe("Toon.encode", () => {
  it.effect("renders an empty collection with TOON's empty-array rule", () =>
    Effect.gen(function* () {
      const toon = yield* Toon.encode({ sessions: [] });
      expect(toon).toBe("sessions: []");
    }),
  );

  it.effect("renders an inline primitive array", () =>
    Effect.gen(function* () {
      const toon = yield* Toon.encode({ tags: ["a", "b", "c"] });
      expect(toon).toBe("tags[3]: a,b,c");
    }),
  );

  it.effect("renders a tabular array of objects", () =>
    Effect.gen(function* () {
      const toon = yield* Toon.encode({
        sessions: [
          { key: "abc", status: "open" },
          { key: "def", status: "ended" },
        ],
      });
      expect(toon).toBe("sessions[2]{key,status}:\n  abc,open\n  def,ended");
    }),
  );
});
