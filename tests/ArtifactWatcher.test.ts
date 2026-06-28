import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ArtifactWatcher } from "../src/ArtifactWatcher.ts";
import { SessionKey } from "../src/Session.ts";
import { SessionHub } from "../src/SessionHub.ts";

/**
 * `ArtifactWatcher` ref-counting (ADR 0010): the per-key watcher starts on the
 * first SSE connection's `track` and stops on the last release. Asserted through
 * the `watching` probe over real `track` scopes, so it is independent of
 * filesystem event timing (the file -> reload path is covered end to end). The
 * real Bun filesystem is provided so the watch starts against a real directory.
 */

const testLayer = ArtifactWatcher.layer.pipe(
  Layer.provideMerge(SessionHub.layer),
  Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);

describe("ArtifactWatcher", () => {
  it.effect("starts on the first track and stops on the last release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const watcher = yield* ArtifactWatcher;

      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "artifact.html");
      yield* fs.writeFileString(file, "<html></html>");
      const key = SessionKey.make("watch-refcount");

      expect(yield* watcher.watching(key)).toBe(false);

      yield* Effect.scoped(
        Effect.gen(function* () {
          // First connection: the watcher starts.
          yield* watcher.track(key, file);
          expect(yield* watcher.watching(key)).toBe(true);

          // Second connection rides the same watcher.
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* watcher.track(key, file);
              expect(yield* watcher.watching(key)).toBe(true);
            }),
          );

          // One released, one still open: the watcher keeps running.
          expect(yield* watcher.watching(key)).toBe(true);
        }),
      );

      // The last connection closed: the watcher stops.
      expect(yield* watcher.watching(key)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
});
