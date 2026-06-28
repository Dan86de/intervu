import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import * as Output from "./Output.ts";
import * as Toon from "./Toon.ts";

const bin = "intervu";
const version = "0.0.0";
const description =
  "Local AXI-style CLI for collaborative review of agent-generated HTML artifacts.";
const help = "run 'intervu <artifact.html>' to open a review session";

/**
 * The single emit boundary: every byte intervu writes to stdout passes through
 * here. It is success-only for now; slice #9 hooks structured-error formatting
 * onto this seam.
 */
const emit = (text: string): Effect.Effect<void> => Console.log(text);

/**
 * The root command. With no subcommands registered, the framework runs this
 * handler on bare invocation, rendering the content-first home view instead of
 * help text. `--version` / `--help` remain framework built-ins.
 */
const root = Command.make(bin, {}, () =>
  Effect.gen(function* () {
    const view = Output.home({ bin, description, sessions: [], help });
    const text = yield* Toon.encode(view);
    yield* emit(text);
  }),
);

const program = Command.run(root, { version }).pipe(
  Effect.provide(BunServices.layer),
);

BunRuntime.runMain(program);
