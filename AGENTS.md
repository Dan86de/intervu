## Local Effect Source

The Effect v4 repository is vendored at `.repos/effect` (gitignored).
Use it as an **API and pattern reference**, not a style reference.

**Use it to answer:**
- Does this function/type exist in v4? What is its current signature?
- What is the idiomatic shape of a `Layer`, `Service` class, `Schema`, `Effect.gen` pipeline?
- How does Effect compose feature X with feature Y in practice?

Note: in v4 a lot lives inside the `effect` package itself - the CLI command
parser is `effect/unstable/cli` and the HTTP server/client is
`effect/unstable/http`, not separate `@effect/cli` / `@effect/platform`
packages. The Bun runtime bindings (`BunRuntime`, `BunHttpServer`,
`BunFileSystem`, `BunPath`, `BunCrypto`) come from `@effect/platform-bun`.

**Do NOT copy its internal style.** The library is the implementation layer and intentionally
does things app code must not.

When you grep the clone, you are looking for *what API to call*, not *how to write your
own modules*.

## GitHub Operations

Use the `gh-axi` skill for **all** GitHub operations in this repository - issues,
pull requests, workflow runs, workflows, releases, repositories, labels, search, and
raw API access. Whenever a task touches GitHub (listing or filing issues, reviewing or
merging PRs, checking CI runs, cutting releases, or querying the GitHub API), invoke
`gh-axi` rather than calling `gh` or the GitHub API directly.

## Code Rules (apply to every file you write in this repo)

Before writing or editing any TypeScript, confirm the change does not introduce any of
the following. After editing, grep your own diff to verify.

1. **No `any` and no type casts.** No `as X`, no `as unknown as X`, no `<any>`, no `: any`.
   The only acceptable `as` is `as const`. If you reach for a cast, the answer is almost
   always `Schema.make()`, `Schema.decodeUnknown(...)`, or `identity` — reshape the types
   instead of papering over them.
2. **No global `Error`.** No `new Error(...)`, no `throw new Error(...)`, no `extends Error`,
   no `e as Error`. All domain errors must be `Schema.TaggedError` and fail through the
   Effect error channel (`Effect.fail`).
3. **No `catchAllCause`.** It swallows defects (bugs) along with typed errors. Use
   `Effect.catchAll` for typed errors or `Effect.mapError` to transform them.
4. **No `disableValidation: true`.** Banned by lint rule. If a schema is failing
   validation, fix the schema or the input.
5. **No `*FromSelf` schemas.** Use the standard variants: `Schema.Option(...)`, not
   `Schema.OptionFromSelf(...)`. Same for any other `FromSelf` sibling.
6. **No `*Sync` variants.** No `Schema.decodeUnknownSync`, `decodeSync`, `encodeSync`,
   `parseSync`, or `Effect.runSync`. Stay async-by-default and run effects through the
   normal runtime.
7. **No `index.ts` barrel files.** Import from the specific module that defines the
   symbol. Do not create re-export hubs.
8. **No `Effect.serviceOption`.** Services must always be present in context, including
   in tests. Yield the service directly (`yield* MyService`) and provide it via your
   layer composition.
9. **No `Effect.ignore` and no silent error swallow.** Do not discard errors with
   `Effect.ignore` or with catch handlers that return `Effect.void` / `Effect.unit`
   (e.g. `catchTag("X", () => Effect.void)`, `catchAll(() => Effect.void)`). Let the
   error propagate, transform it with `Effect.mapError`, or handle it meaningfully.
10. **No `Effect.asVoid`.** The `void` return type already accepts any success value;
    `asVoid` is noise.

### Pre-write checklist (run mentally before each edit)

- Am I about to write `as`? → reach for `Schema.decodeUnknown` or refine the type.
- Am I about to write `new Error(`? → define a `Schema.TaggedError` and `Effect.fail` it.
- Am I about to write `*Sync` or `runSync`? → keep the effect async and compose it.
- Am I creating an `index.ts`? → don't; import from the leaf module.
- Am I about to swallow an error (`Effect.ignore`, `() => Effect.void`)? → propagate,
  `mapError`, or handle it.

### Post-write verification

After any non-trivial edit, run a quick grep over the changed files:

```sh
grep -nE '\b(as [A-Z]|: any\b|<any>|new Error\(|catchAllCause|disableValidation|FromSelf|decodeUnknownSync|decodeSync|encodeSync|parseSync|runSync|Effect\.serviceOption|Effect\.ignore|Effect\.asVoid)\b' <changed-files>
grep -nE '(catchTag\([^,]+,\s*\(\)\s*=>\s*Effect\.(void|unit)|catchAll\(\s*\(\)\s*=>\s*Effect\.(void|unit))' <changed-files>
find <changed-dirs> -name index.ts
```

Any hit (other than `as const`) is a violation — fix before reporting the task done.

### Effect guides
Effect guides live under `specs/guides/`.

### Domain docs
Single-context layout: `CONTEXT.md` at the repo root, ADRs under `docs/adr/`.
