import { encode as toonEncode } from "@toon-format/toon";
import { Effect } from "effect";

/**
 * Thin Effect facade over the published `@toon-format/toon` encoder.
 *
 * intervu uses TOON encode-only - nothing parses it back - so this module
 * exposes just `encode`, the default output format for all CLI output. The
 * upstream encoder is synchronous and total for serializable input; wrapping it
 * in `Effect.sync` surfaces a non-encodable value (e.g. a cyclic structure) as a
 * defect through the runtime instead of a raw throw.
 */
export const encode = (value: unknown): Effect.Effect<string> =>
  Effect.sync(() => toonEncode(value));
