# Discovery wiring: a session-start hook merged into user-level settings, with the skill baked into the binary

`intervu setup` makes intervu discoverable to the agent (#11) by wiring two halves - the **Skill** (the loop's description) and the **Hook** (ambient context at session start) - into Claude Code's configuration.
Four decisions shape that wiring.

**A session-start hook, not a per-prompt hook.**
The Hook is a `SessionStart` entry, so the ambient context is injected once when the session begins, not re-injected on every turn, which would be noise.
Its payload is bare `intervu`'s **Home view** reused as-is: no new read path is introduced, and the Home view's existing no-daemon, no-network, persisted-state-only behavior (ADR 0013) is exactly what a hook firing at session start needs to stay fast and free of side effects.

**User-level scope by default, project-level behind a flag.**
`setup` writes to the user-level `<home>/.claude` by default, so discovery is global across every project with no per-repo wiring.
`--project` retargets both halves to the current repo's `<cwd>/.claude` for someone who wants to scope intervu to one repo, and `--skill-only` / `--hooks-only` wire a single half without the other.
The default is to wire everything; the partial flags exist only for the cases that want one half.

**An idempotent, schema-checked, no-clobber settings merge.**
The settings file is read, decoded through a `Schema` (`ClaudeSettings.schema`), merged purely, then written back; intervu never parses the file into an untyped value.
The schema types only the slice intervu touches - the `SessionStart` matcher groups - and preserves every other setting, hook event, matcher group, and entry field verbatim through `StructWithRest` rest entries, so a merge leaves unrelated configuration untouched.
The pure merge (`ClaudeSettings.mergeHook`) recognizes intervu's own hook by its `intervu` command, so a second run is a clean no-op reporting unchanged - that command match is the whole idempotency check.
intervu refuses to overwrite a file it cannot decode: a malformed settings file fails with a structured `SettingsFileUnparseable` and an unreadable one with `SettingsFileUnreadable` rather than being clobbered, and the rewrite is atomic (tmp + rename) so a crash mid-write never corrupts the config.

**The skill is baked inside the single binary.**
The Skill's canonical markdown (`src/skill/SKILL.md`) is frozen into a generated module (`src/generated/skillAsset.ts`) at build time by `scripts/build-skill.ts`, the same mechanism the browser assets use (ADR 0007).
So the shipped single-file binary carries the Skill string and `setup` can write it out with no source tree present; running from source, `SkillAsset.layer` instead reads `SKILL.md` directly so an edit is live on the next run.

## Considered options

- **A per-prompt hook that re-injects context every turn** - rejected: the live-Sessions context only needs to land once per session, so re-injecting it each turn is noise on the agent's context for no new information.
- **Project-level configuration by default** - rejected: discovery should work across every project out of the box; per-repo wiring is the exception, so it lives behind `--project` rather than being the default.
- **A blind overwrite (or untyped read-modify-write) of the settings file** - rejected: it would destroy a human's unrelated settings and silently corrupt a malformed file; the schema-checked, no-clobber merge preserves everything else and surfaces an unparseable file as a structured error instead.
- **Serving the Skill from the source tree or `dist/` at runtime** - rejected for the same reason as the browser assets (ADR 0007): the shipped binary has no source tree to read from, so the Skill must be baked into the single file for `setup` to write it out.

## Consequences

- The Hook depends on the Home view staying daemon-free and network-free (ADR 0013); a future change that makes bare `intervu` touch the daemon would put a network call and a daemon dependency on every session start.
- The settings schema is a deliberate partial model: it types only the `SessionStart` slice and round-trips everything else through `StructWithRest`. A reader extending it must keep that rest-preserving shape, or the merge will start dropping settings it does not model.
- `setup` is additive and idempotent; there is no uninstall or teardown command, and re-running it after a Skill edit overwrites the installed `SKILL.md` (skill versioning beyond that idempotent overwrite is out of scope).
