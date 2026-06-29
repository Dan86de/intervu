import { Effect, Layer, Option } from "effect";
import * as Context from "effect/Context";

/**
 * Resolves a command name against the process `PATH`, the way the agent's shell
 * and the Claude Code harness do when they later run that command. `intervu
 * setup` uses it as a precondition: the Skill and the Hook it writes both shell
 * out to a bare `intervu`, so wiring them is only meaningful when an `intervu`
 * binary actually resolves on `PATH` - a global install, not a transient `bunx`
 * run (ADR 0019).
 *
 * The production layer delegates to `Bun.which`, which applies the same PATH
 * lookup (and executable-bit / platform rules) the harness will at invocation
 * time, so the check matches what actually happens when the command runs. Tests
 * provide a stub, so setup's precondition is exercised without touching the real
 * environment.
 */
export interface CommandResolverShape {
  /** The absolute path the command resolves to on `PATH`, or `None` when it is
   * not found there. */
  readonly resolve: (command: string) => Effect.Effect<Option.Option<string>>;
}

export class CommandResolver extends Context.Service<
  CommandResolver,
  CommandResolverShape
>()("@intervu/CommandResolver") {
  static readonly layer = Layer.succeed(CommandResolver, {
    resolve: (command) =>
      Effect.sync(() => Option.fromNullishOr(Bun.which(command))),
  });
}
