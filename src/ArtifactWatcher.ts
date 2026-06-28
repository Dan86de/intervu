import {
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  type Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import * as Context from "effect/Context";
import type { SessionKey } from "./Session.ts";
import { ArtifactReloaded, SessionHub } from "./SessionHub.ts";

/**
 * The lazy, ref-counted file watcher behind live-reload (ADR 0010). A watcher
 * for a key runs only while at least one SSE connection for that key is open:
 * `track` is acquired on the SSE stream's scope, starting the watcher on the
 * first connection and stopping it on the last. This ref-count is deliberately
 * separate from the Presence poll counter - a browser connection drives reload,
 * not the agent's listening/working state.
 *
 * The watcher watches the artifact's parent directory filtered to its basename
 * (robust to an editor's atomic-save rename-replace, which a direct file watch
 * would miss), debounces a burst of events ~100ms, and publishes
 * `ArtifactReloaded` through the hub like every other server-driven push. Sibling
 * assets do not trigger a reload this slice.
 */

interface Watcher {
  readonly count: number;
  readonly fiber: Fiber.Fiber<void>;
}

const DEBOUNCE = "100 millis";

export class ArtifactWatcher extends Context.Service<
  ArtifactWatcher,
  {
    readonly track: (
      key: SessionKey,
      artifactPath: string,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly watching: (key: SessionKey) => Effect.Effect<boolean>;
  }
>()("@intervu/ArtifactWatcher") {
  static readonly layer = Layer.effect(
    ArtifactWatcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hub = yield* SessionHub;
      // The daemon-lifetime scope the watcher fibers are forked into, so a fiber
      // outlives the connection that started it (other connections may keep the
      // ref-count up) and is interrupted explicitly on the last release.
      const scope = yield* Effect.scope;
      const watchers = yield* SynchronizedRef.make(
        new Map<SessionKey, Watcher>(),
      );

      const watcherFor = (key: SessionKey, artifactPath: string) => {
        const dir = path.dirname(artifactPath);
        const base = path.basename(artifactPath);
        return fs.watch(dir).pipe(
          Stream.filter((event) => path.basename(event.path) === base),
          Stream.debounce(DEBOUNCE),
          Stream.runForEach(() => hub.publish(key, new ArtifactReloaded())),
          Effect.catch((error) =>
            Effect.logError("artifact watch failed", error),
          ),
        );
      };

      const track = (key: SessionKey, artifactPath: string) =>
        SynchronizedRef.modifyEffect(watchers, (map) =>
          Effect.gen(function* () {
            const existing = map.get(key);
            if (existing !== undefined) {
              const next = new Map(map);
              next.set(key, { ...existing, count: existing.count + 1 });
              return [undefined, next] as const;
            }
            const fiber = yield* watcherFor(key, artifactPath).pipe(
              Effect.forkIn(scope),
            );
            const next = new Map(map);
            next.set(key, { count: 1, fiber });
            return [undefined, next] as const;
          }),
        ).pipe(Effect.flatMap(() => Effect.addFinalizer(() => release(key))));

      const release = (key: SessionKey) =>
        SynchronizedRef.modifyEffect(watchers, (map) =>
          Effect.gen(function* () {
            const existing = map.get(key);
            if (existing === undefined) {
              return [undefined, map] as const;
            }
            if (existing.count > 1) {
              const next = new Map(map);
              next.set(key, { ...existing, count: existing.count - 1 });
              return [undefined, next] as const;
            }
            yield* Fiber.interrupt(existing.fiber);
            const next = new Map(map);
            next.delete(key);
            return [undefined, next] as const;
          }),
        );

      const watching = (key: SessionKey): Effect.Effect<boolean> =>
        SynchronizedRef.get(watchers).pipe(Effect.map((map) => map.has(key)));

      return { track, watching };
    }),
  );
}
