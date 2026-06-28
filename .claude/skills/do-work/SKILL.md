---
name: do-work
description: Execute one unit of work in the intervu repo end-to-end — plan, implement, run the local feedback loop (format/lint/check/types/tests), and commit. Use when the user asks to "do work", "ship this task", "implement and commit", or otherwise hands you a scoped piece of work in this repo and expects it taken all the way to a green commit.
---

# do-work

A single trip through: **plan → confirm → implement → feedback loop → commit.** One unit of work = one commit on the current branch. No branch creation, no push.

## References (consult before planning)

- **`specs/guides/`** — repo conventions for Effect work. Skim the relevant file(s) before planning: `effect-basics.md`, `services-and-layers.md`, `data-modeling.md`, `error-handling.md`, `config.md`, `testing.md`. The plan and implementation must conform to these guides.
- **`.repos/effect`** — vendored Effect v4 source clone. Use it to confirm API shapes, find usage examples, and read implementation details when guides/docs aren't enough. Prefer this over guessing at signatures. In v4 the CLI parser lives at `effect/unstable/cli` and the HTTP server at `effect/unstable/http`; Bun bindings come from `@effect/platform-bun`.
- **`CONTEXT.md`** and **`docs/adr/`** — the ubiquitous language and the architectural decisions. Conform to the established vocabulary; don't reintroduce a retired term.

## 1. Plan (inline, concise)

Write a short plan directly in chat. Follow the user's global plan-mode preference: sacrifice grammar for concision. End with a list of unresolved questions (if any).

Include:

- **Goal** — one line, what "done" looks like.
- **Touch list** — files you expect to create or modify (`path:line` when known).
- **Approach** — bullets, not prose. Note non-obvious trade-offs only.
- **Test plan** — what new/changed tests will exist, or why none are needed.
- **Unresolved questions** — numbered list, or "none."

Then **stop and ask the user to confirm or adjust** before implementing. Do not start editing until they reply.

## 2. Implement

Once confirmed:

- Make the smallest set of edits that achieves the goal.
- Match the surrounding code's idiom, naming, and comment density (see global Claude Code guidance).
- Add or update tests alongside the code change.
- Don't refactor unrelated code. Surface temptations as follow-ups instead.

## 3. Feedback loop

Run these in order. On any failure: fix, then **re-run from the failing step** (not the whole chain). Repeat until all five pass clean.

```bash
bun run format       # biome format --write
bun run lint         # biome lint --write
bun run check        # biome check --write (combined + import sort)
bun run check:types  # type-check (uses the effect-tsgo-patched tsc)
bun run test         # vitest run (@effect/vitest)
```

Notes:

- `format`, `lint`, `check` auto-write — re-stage anything they touched.
- If `bun run test` matches no test files, that's fine (`--passWithNoTests`); don't fabricate tests just to have output.
- If a failure is in code you didn't touch and is unrelated to your change, stop and tell the user — don't fix it silently inside this unit of work.

## 4. Commit

Only after the loop is green:

1. `git status` + `git diff --stat` — confirm the change set is exactly what you intend. If unexpected files appear (e.g. tooling-generated), investigate before staging.
2. `git add` the relevant paths (avoid blanket `git add -A` unless you've just verified the diff is clean).
3. `git commit -m "<message>"` on the **current branch** — do not create or switch branches.

Commit message: imperative subject ≤72 chars, matching the style of recent commits (`git log -5 --oneline` to check). Body only if the "why" isn't obvious from the diff. No Claude/Anthropic attribution lines.

Do **not** push. Report back with the commit SHA, subject, and one-line summary of what's now green.

## Failure handling

- **User rejects the plan** → revise, re-present, wait again. Don't implement a half-approved plan.
- **Feedback loop won't converge after ~3 fix attempts on the same step** → stop, paste the failing output, ask for direction.
- **Scope creep mid-implementation** → finish the agreed unit, commit it, then raise the new work separately.
