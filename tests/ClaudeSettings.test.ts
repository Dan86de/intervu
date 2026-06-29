import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as ClaudeSettings from "../src/ClaudeSettings.ts";

/**
 * ClaudeSettings.mergeHook exercised as pure input/output: each test decodes a
 * settings value through `fromJson` (no filesystem), merges, and asserts the
 * verdict and the preserved/added shape - re-encoding when it needs to inspect
 * what survives a round trip.
 */

const HOOK = ClaudeSettings.intervuHookCommand;

const decode = (json: string) =>
  Schema.decodeUnknownEffect(ClaudeSettings.fromJson)(json);

const reencode = (settings: ClaudeSettings.Settings) =>
  Schema.encodeEffect(ClaudeSettings.fromJson)(settings);

describe("ClaudeSettings.mergeHook", () => {
  it.effect("adds the hook to an empty settings value", () =>
    Effect.gen(function* () {
      const settings = yield* decode("{}");
      const { settings: merged, changed } = ClaudeSettings.mergeHook(
        settings,
        HOOK,
      );

      expect(changed).toBe(true);
      const groups = merged.hooks?.SessionStart ?? [];
      expect(groups).toHaveLength(1);
      expect(groups[0]?.hooks).toContainEqual({
        type: "command",
        command: HOOK,
      });
    }),
  );

  it.effect("a second merge is a no-op reporting unchanged", () =>
    Effect.gen(function* () {
      const settings = yield* decode("{}");
      const first = ClaudeSettings.mergeHook(settings, HOOK);
      expect(first.changed).toBe(true);

      const second = ClaudeSettings.mergeHook(first.settings, HOOK);
      expect(second.changed).toBe(false);
      expect(second.settings).toBe(first.settings);

      // No duplicate hook entry.
      const groups = second.settings.hooks?.SessionStart ?? [];
      expect(groups).toHaveLength(1);
    }),
  );

  it.effect(
    "preserves unrelated settings, hook events, and matcher groups",
    () =>
      Effect.gen(function* () {
        const settings = yield* decode(
          JSON.stringify({
            model: "opus",
            permissions: { allow: ["Bash"] },
            hooks: {
              PreToolUse: [
                {
                  matcher: "Bash",
                  hooks: [{ type: "command", command: "echo hi" }],
                },
              ],
              SessionStart: [
                {
                  matcher: "startup",
                  hooks: [
                    { type: "command", command: "other-tool", timeout: 5 },
                  ],
                },
              ],
            },
          }),
        );

        const { settings: merged, changed } = ClaudeSettings.mergeHook(
          settings,
          HOOK,
        );
        expect(changed).toBe(true);

        const json = yield* reencode(merged);
        const parsed = JSON.parse(json);

        // Unrelated top-level settings survive verbatim.
        expect(parsed.model).toBe("opus");
        expect(parsed.permissions).toEqual({ allow: ["Bash"] });
        // Unrelated hook events survive verbatim.
        expect(parsed.hooks.PreToolUse).toEqual([
          { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
        ]);
        // The unrelated SessionStart group survives, and intervu's is appended.
        const commands = parsed.hooks.SessionStart.flatMap(
          (group: { hooks: { command: string }[] }) =>
            group.hooks.map((entry) => entry.command),
        );
        expect(commands).toContain("other-tool");
        expect(commands).toContain(HOOK);
        // The unrelated entry keeps its extra fields.
        expect(parsed.hooks.SessionStart[0].hooks[0].timeout).toBe(5);
      }),
  );

  it.effect("recognizes an already-present hook under a different group", () =>
    Effect.gen(function* () {
      const settings = yield* decode(
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: HOOK }] },
              {
                matcher: "resume",
                hooks: [{ type: "command", command: "other-tool" }],
              },
            ],
          },
        }),
      );

      const { changed } = ClaudeSettings.mergeHook(settings, HOOK);
      expect(changed).toBe(false);
    }),
  );

  it.effect("rejects malformed JSON through the error channel", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decode("{ not valid json"));
      expect(error._tag).toBe("SchemaError");
    }),
  );
});
