# Session key is derived from the artifact's path, not its content

## Status

accepted

## Context and decision

A Session must be addressable by a stable key so that re-running `intervu open <file>` (or the bare-file alias) resumes the same review session idempotently.
Issue #1 described this as "content-addressed session key derivation", but the defining behaviour of intervu is that the agent **live-edits the artifact's bytes** throughout a review.
A key derived from file content would therefore change on every edit, orphaning the in-flight Session and breaking resume.
We derive the session key from the artifact's **normalized absolute path** instead - `hash(realpath(artifact))` - which is stable across content edits.

## Considered options

- **Content hash of the artifact bytes** - rejected: changes on every agent edit, breaking mid-review resume; also merges two distinct files that happen to share content into one Session.
- **Path hash (`hash(realpath)`)** - chosen: stable across edits, deterministic, no sidecar; `realpath` collapses symlink and relative-path aliases to one Session.
- **Random id in a sidecar file next to the artifact** - rejected: pollutes the artifact directory and complicates the path-confined asset serving, for no benefit over a path hash.

## Consequences

- Two files with identical content at different paths are two separate Sessions (correct).
- Renaming or moving the artifact mid-review yields a new key and orphans the old Session; this is explicitly out of scope for the MVP (the human is not expected to rename an artifact under review).
- The word "content-addressed" in issue #1 is superseded; see the Flagged ambiguities in `CONTEXT.md`.
