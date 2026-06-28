# CLI error-output contract

AXI mandates structured errors on stdout with clean exit codes (0 success, 1 error).
We split the failure surface into three tiers, each rendered differently, and wire it onto the single `emit` seam in `main.ts` with `runMain(program, { disableErrorReporting: true })` so the runtime never double-prints what we (or the framework) already rendered.

- **Typed errors** that reach the seam un-rendered are caught with `Effect.tapError` and printed as a structured TOON envelope on stdout, exit 1. Known domain `TaggedError`s get a tailored message plus a per-tag next-step help line (e.g. `ReviewNotOpen` -> "open it first - run 'intervu <file>'"); any other typed error (`HttpClientError` / `SchemaError` / `PlatformError`) gets a generic envelope pointing at the daemon log.
- **Defects** (`die` - bugs) are left raw and loud on stderr via `Effect.tapDefect` (pretty cause), exit 1. They are never masked as a clean structured error, so bugs stay debuggable.
- **Framework parse/usage errors** (`CliError.ShowHelp`, e.g. `intervu poll` with no file) keep the Effect CLI framework's own rendering (it already prints the help doc to stdout); `tapError` no-ops on them, exit 1.

`disableErrorReporting` only suppresses the runtime's automatic failure log; `defaultTeardown` still computes the exit code, so every failure path exits 1.

## Consequences

- Parse/usage errors are intentionally not reshaped into TOON - fighting the framework's hardcoded stdout/stderr split for a rare agent-mis-invocation case is not worth the complexity. A future reader who wants one uniform envelope for *every* failure should know this asymmetry is deliberate.
