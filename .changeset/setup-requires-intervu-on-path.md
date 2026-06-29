---
"intervu": patch
---

Fix `intervu setup` wiring a skill and session-start hook that could not run.
Both invoke a bare `intervu`, which only resolves after a global install, so users who ran the loop via `bunx intervu` got artifacts pointing at a command that was not on their `PATH`.
Setup now resolves `intervu` on `PATH` before writing anything and refuses with a clear `bun add -g intervu` message instead of silently wiring a broken loop (ADR 0019).
