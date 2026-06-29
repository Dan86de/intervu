# Setup requires a resolvable `intervu` on PATH

`intervu setup` writes two discovery artifacts (ADR 0017): the agent Skill, which tells the agent to run `intervu <file>` and `intervu poll <file>`, and a `SessionStart` Hook, whose command is a bare `intervu`.
Both shell out to `intervu` by name, so both only work when an `intervu` binary resolves on the user's `PATH`.

ADR 0018 shipped intervu as an npm package runnable via `bunx intervu`, and reasoned that this made the discovery wiring "reachable from anywhere."
That reasoning does not hold for the wiring itself: `bunx intervu` runs the binary transiently and never installs an `intervu` onto `PATH`.
A user who runs `bunx intervu setup` therefore gets a Skill and a Hook that both invoke an `intervu` that does not exist, and every `intervu <file>` the agent tries - and every session-start hook - fails with command-not-found.
This is the reported symptom: users who followed the `bunx` path could not invoke `intervu <file>` after setup.

**Setup refuses unless `intervu` resolves on `PATH`.**
`Setup.install` resolves the `intervu` command against `PATH` before it writes anything and fails `IntervuNotOnPath` when it is absent, so a broken Skill + Hook is never left on disk.
The lookup goes through a `CommandResolver` service whose production layer delegates to `Bun.which` - the same PATH and executable-bit resolution the harness and the agent's shell apply when they later run the command - so the check matches what actually happens at invocation time.
The precondition is universal: it guards `--skill-only` and `--hooks-only` too, because each half invokes `intervu` on its own.

**A global install is the supported path for the agent loop; `bunx` stays a one-off.**
`bun add -g intervu` puts `intervu` on `PATH`, after which `intervu setup` succeeds and the baked bare-`intervu` artifacts are correct.
`bunx intervu report.html` remains fine for a one-off manual look at an artifact, but it is not enough to wire the loop, and the README now says so rather than leading with it.

## Considered options

- **Bake `bunx intervu` into the Skill and Hook instead of a bare `intervu`** - rejected: it makes setup work without a global install, but every `intervu poll` (a long-poll loop) and every session-start hook would re-resolve through `bunx`, paying its cache/registry lookup on a hot path. A stable on-`PATH` binary is the right shape for a command an agent runs repeatedly.
- **Template the command token at setup time** (write whatever invocation resolves) - deferred: more machinery than the problem needs once a global install is required, and it would still bake the slow `bunx` form when that is all that resolves.
- **Warn but write anyway** - rejected: it leaves exactly the broken Skill + Hook this ADR exists to prevent, and the failure would surface later as an opaque command-not-found inside the agent loop rather than at the point of setup.

## Consequences

- `intervu setup` now fails fast with an actionable message (`bun add -g intervu`, then re-run) when `intervu` is not on `PATH`, instead of silently producing artifacts that fail at invocation.
- Running setup from a source checkout (`bun src/main.ts setup`) requires an `intervu` on `PATH`; the unit tests inject a `CommandResolver` stub, so they exercise both the present and absent branches without depending on the real environment.
- `CommandResolver`'s production layer reads the `Bun.which` global, keeping with the Bun-everywhere stack (ADR 0018); it is the one place setup touches process `PATH` state.
