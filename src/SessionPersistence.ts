import {
  Effect,
  FileSystem,
  Layer,
  type PlatformError,
  Ref,
  Schema,
} from "effect";
import * as Context from "effect/Context";
import { AppConfig } from "./AppConfig.ts";
import { Session } from "./Session.ts";

/**
 * The versioned envelope written to the single state file. The `version` field
 * lets later slices migrate the on-disk shape without guessing.
 */
const StateEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(Session),
});

/** Codec between the envelope and its JSON-string form (parse + decode in one). */
const StateEnvelopeFromJson = Schema.fromJsonString(StateEnvelope);

/**
 * The persistence seam beneath `SessionStore` (ADR 0002): `fileLayer` durably
 * stores the session set in the per-user state file; `memoryLayer` is an
 * in-process `Ref` so the store logic is tested with zero filesystem touched.
 * The store, not this port, owns key derivation and the open-status machine -
 * this is pure load/save of the whole session set.
 */
export class SessionPersistence extends Context.Service<
  SessionPersistence,
  {
    readonly load: Effect.Effect<
      readonly Session[],
      PlatformError.PlatformError | Schema.SchemaError
    >;
    readonly save: (
      sessions: readonly Session[],
    ) => Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError>;
  }
>()("@intervu/SessionPersistence") {
  /**
   * Persists to `<stateDir>/state.json`, writing a `*.tmp` sibling then
   * atomically `rename`-ing it into place. A missing file loads as no sessions.
   */
  static readonly fileLayer = Layer.effect(
    SessionPersistence,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* AppConfig;

      const load = Effect.gen(function* () {
        const exists = yield* fs.exists(config.stateFile);
        if (!exists) {
          return [];
        }
        const text = yield* fs.readFileString(config.stateFile);
        const envelope = yield* Schema.decodeUnknownEffect(
          StateEnvelopeFromJson,
        )(text);
        return envelope.sessions;
      });

      const save = (sessions: readonly Session[]) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(config.stateDir, { recursive: true });
          const json = yield* Schema.encodeEffect(StateEnvelopeFromJson)({
            version: 1,
            sessions,
          });
          const tmp = `${config.stateFile}.tmp`;
          yield* fs.writeFileString(tmp, json);
          yield* fs.rename(tmp, config.stateFile);
        });

      return { load, save };
    }),
  );

  /** In-process `Ref`-backed persistence for tests; `initial` seeds a respawn. */
  static readonly memoryLayer = (initial: readonly Session[] = []) =>
    Layer.effect(
      SessionPersistence,
      Effect.gen(function* () {
        const ref = yield* Ref.make(initial);
        return {
          load: Ref.get(ref),
          save: (sessions: readonly Session[]) => Ref.set(ref, sessions),
        };
      }),
    );
}
