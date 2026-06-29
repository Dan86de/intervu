import { Effect, Schema } from "effect";

/**
 * The slice of the Claude Code harness settings file (`~/.claude/settings.json`)
 * that intervu touches: the `SessionStart` hook entries. This module owns the
 * `Schema` for that slice and a pure merge function; the filesystem read/write
 * lives in `Setup`.
 *
 * The schema types only what intervu needs (the `SessionStart` matcher groups
 * and their command entries) and preserves everything else verbatim through
 * `Record(String, Unknown)` rest entries at each level: unrelated top-level
 * settings, unrelated hook events, unrelated matcher groups, and extra entry
 * fields (e.g. `timeout`) all round-trip untouched. intervu never parses the
 * file into an untyped value and never overwrites a file it cannot decode.
 */

/** Bare `intervu`'s command; its presence is how the merge recognizes our own
 * hook (ADR 0013: the Home view it prints is injected as session-start context). */
export const intervuHookCommand = "intervu";

/** A single command hook entry; `type` and any extra fields ride the rest. */
const HookEntry = Schema.StructWithRest(
  Schema.Struct({ command: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** One matcher group: its command entries, plus any other fields preserved. */
const HookMatcherGroup = Schema.StructWithRest(
  Schema.Struct({ hooks: Schema.Array(HookEntry) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** The `hooks` object: `SessionStart` typed, every other event preserved. */
const Hooks = Schema.StructWithRest(
  Schema.Struct({
    SessionStart: Schema.optionalKey(Schema.Array(HookMatcherGroup)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** The settings file: `hooks` typed, every other setting preserved. */
export const schema = Schema.StructWithRest(
  Schema.Struct({ hooks: Schema.optionalKey(Hooks) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** The decoded settings value the merge operates on. */
export type Settings = typeof schema.Type;

/** Codec between the on-disk JSON text and the settings value: parse + validate
 * the slice in one step. Encoding goes through {@link toJson} so the written file
 * is pretty-printed. */
export const fromJson = Schema.fromJsonString(schema);

/**
 * Serialize a settings value to the on-disk JSON text, pretty-printed with
 * two-space indent - the shape a human-edited config expects (`fromJson`'s own
 * encoder is compact). Fails `SchemaError` only if the value does not match the
 * slice schema, which a decoded-then-merged value never does.
 */
export const toJson = (settings: Settings): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(schema)(settings).pipe(
    Effect.map((encoded) => JSON.stringify(encoded, null, 2)),
  );

/** The outcome of {@link mergeHook}: the (possibly unchanged) settings and whether
 * a write is needed. */
export interface MergeResult {
  readonly settings: Settings;
  readonly changed: boolean;
}

/**
 * Add intervu's `SessionStart` hook to `settings`, idempotently. If any existing
 * `SessionStart` entry already runs `command`, the settings are returned
 * unchanged (`changed: false`); otherwise a new matcher group running `command`
 * is appended, creating the `hooks`/`SessionStart` containers if absent. Pure -
 * no filesystem - so idempotency and no-clobber correctness are unit testable in
 * isolation. Unrelated settings, hook events, and matcher groups are untouched.
 */
export const mergeHook = (settings: Settings, command: string): MergeResult => {
  const existingHooks = settings.hooks;
  const groups = existingHooks?.SessionStart ?? [];
  const present = groups.some((group) =>
    group.hooks.some((entry) => entry.command === command),
  );
  if (present) {
    return { settings, changed: false };
  }

  const sessionStart = [...groups, { hooks: [{ type: "command", command }] }];
  const hooks = existingHooks
    ? { ...existingHooks, SessionStart: sessionStart }
    : { SessionStart: sessionStart };
  const merged: Settings = { ...settings, hooks };
  return { settings: merged, changed: true };
};
