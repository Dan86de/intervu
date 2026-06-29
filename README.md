# intervu

intervu is a local, AXI-style CLI that turns an agent-generated HTML artifact
into a collaborative browser review surface: the human annotates the rendered
page, and the agent long-polls for that feedback and live-edits the file.

See [`CONTEXT.md`](CONTEXT.md) for the ubiquitous language and
[`docs/adr/`](docs/adr/) for the architectural decisions.

## Install

intervu ships as a single self-contained [Bun](https://bun.sh) binary, so it
needs Bun on your `PATH`. Run it without installing anything:

```bash
bunx intervu report.html
```

Or install it globally so `intervu` is always on hand:

```bash
bun add -g intervu
intervu report.html
```

Then run `intervu setup` once to make the review loop discoverable to your agent
(installs the agent skill and the session-start hook).

## Local development

Install dependencies:

```bash
bun install
```

Run the dev server (watches and restarts on file changes):

```bash
bun run dev
```

## Usage

Open an artifact for review - launches the browser chrome around it:

```bash
intervu open report.html
# bare-file alias:
intervu report.html
```

Long-poll for human feedback; blocks until the human acts, then returns the
queued feedback as TOON. Safe to kill and re-run with no loss:

```bash
intervu poll report.html
# post a reply into the human's conversation panel as you re-poll:
intervu poll report.html --agent-reply "tightened both headings"
```

## Feedback loop

```bash
bun run format       # biome format --write
bun run lint         # biome lint --write
bun run check        # biome check --write (combined + import sort)
bun run check:types  # tsc --noEmit (effect-tsgo-patched)
bun run test         # vitest run
```
