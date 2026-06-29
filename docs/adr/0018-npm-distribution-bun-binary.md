# Distribution: an unscoped public npm package whose bin is the self-contained Bun binary

intervu ships to agents as an npm package so any machine with Bun can run `bunx intervu`, which is what makes the just-shipped discovery wiring (ADR 0017) reachable from anywhere rather than only from this checkout.
Four decisions shape how it is packaged.

**An npm package that requires Bun, not a Node package and not a standalone compiled binary.**
The entrypoint wires `BunRuntime` and the Bun platform services (`@effect/platform-bun`), so the artifact is a Bun program, not a Node one.
Distribution is therefore an npm package whose `bin` is the existing single-file bundle (ADR 0007) carrying a `#!/usr/bin/env bun` shebang, run as `bunx intervu`; `engines.bun` records the requirement.
This matches the project's Bun-everywhere stack and keeps the pipeline to one `bun build` step, at the cost of requiring Bun on the consuming machine - acceptable because the consumer is an agent on a developer's box that already runs this stack.

**The published `bin` is the self-contained bundle; runtime dependencies move to `devDependencies`.**
`scripts/build.ts` produces `dist/intervu` with every dependency inlined - verified that the bundle carries zero external imports of `effect`, `@effect/platform-bun`, `@medv/finder`, or `@toon-format/toon` (and no `node:`/`bun:` imports; Bun globals are read at runtime).
So `effect`, `@effect/platform-bun`, `@medv/finder`, and `@toon-format/toon` are `devDependencies`: they are build-time inputs to the bundle, not runtime requirements of the published package.
Listing them as runtime `dependencies` would make `bunx intervu` redundantly reinstall the entire effect tree that is already baked into the binary.
`files` is `["dist"]`, so the tarball is the binary plus the always-included `package.json`, `README`, and `LICENSE` - no source tree, no `node_modules`.

**An unscoped public name, `intervu`.**
The name is unclaimed on npm, so the package is the bare `intervu` rather than a scope, matching the command the agent already types.

**`prepack` builds the binary so every tarball is freshly bundled.**
`prepack` runs the full `build` (`build:browser` + `build:skill` + bundle) before packing, so a published tarball can never carry a stale `dist/intervu` and the build is never a manual pre-publish step.
`prepare` (the `effect-tsgo` patch) stays a dev-and-publish-only concern: npm does not run it when installing a published tarball from the registry, so a consumer only ever runs the baked `dist/intervu`.

## Considered options

- **A Node-targeted package** - rejected: the entrypoint wires `BunRuntime`/`BunServices`, so retargeting to Node would mean reimplementing the runtime and platform layer against `@effect/platform-node`, a rewrite this slice does not need.
- **`bun build --compile` standalone per-OS executables shipped via GitHub Releases plus an npm installer shim** - removes the Bun-on-host requirement, but adds a per-platform build matrix, release-asset plumbing, and a download-on-install step. Deferred: heavier than the MVP needs while the consumer already runs Bun. The self-contained-bundle decision above is what keeps that door open later.
- **A scoped name (`@dan86de/intervu`)** - rejected: `intervu` is free, and an unscoped name matches the command the agent types and avoids `publishConfig.access` ceremony.
- **Keeping the four packages in `dependencies`** - rejected: the bundle inlines them, so they are not runtime requirements; declaring them as such would force `bunx intervu` to reinstall a large tree it never loads.

## Consequences

- Consumers need Bun on `PATH`; this is recorded in `engines.bun` and the README install section, and surfaces as an engine warning rather than a silent failure if it is missing.
- The bundle must stay fully self-contained. If a future dependency cannot be inlined (a native addon, a dynamic `require`), it has to be re-added to `dependencies` - the standing check is `npm pack` followed by running the bin from a clean directory with no dev install present.
- There is no separate `build` step to remember before publishing: `prepack` owns it, and the sibling release automation (Changesets) builds again before `changeset publish`.
