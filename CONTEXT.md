# intervu

intervu is a local, AXI-style CLI that turns an agent-generated HTML artifact into a collaborative browser review surface: the human annotates the rendered page, and the agent long-polls for that feedback and live-edits the file.

## Language

### The review surface

**Artifact**:
The agent-generated HTML file - plus any sibling assets it references by relative path - that is under review.
_Avoid_: file, document, page

**Session**:
The review context for one artifact - its queue of pending feedback, its conversation (feedback and agent-replies), and a reversible status (`open` -> `ended` via an **End**, then back to `open` if the path is re-opened) - identified by a key derived from the artifact's normalized absolute path (`hash(realpath)`), stable across the agent's edits so that re-running `open` on the same path resumes the same Session. Because the key is path-based there is exactly one Session per path, so `end` is reversible (a re-open resurrects an `ended` Session to `open`), not destructive.
_Avoid_: tab, window, connection

**Chrome**:
intervu's review UI wrapping the artifact: a slim top bar plus a conversation panel, rendered around the artifact's sandboxed iframe.
_Avoid_: toolbar, shell, frame, wrapper

**Annotation**:
A marker the human attaches to a clicked element or a selected run of text in the artifact, carrying a stable CSS selector and the surrounding context for that target.
_Avoid_: comment, marker, note, pin

**Bridge**:
The only path across the artifact iframe's opaque-origin boundary (ADR 0003): a namespaced `postMessage` exchange between the iframe and the chrome. Messages are validated by frame reference, not origin, and flow both ways - the human's annotations travel up (iframe to chrome), annotation removals and mode changes travel down (chrome to iframe), and at Send the chrome requests a **DOM snapshot** (down) which the iframe returns as serialized live DOM (up).
_Avoid_: connection, link; the server-to-browser **SSE stream** (#7) is a separate path, not the Bridge.

**Annotate-mode**:
A toggle state of the chrome. On: clicks and text selections in the artifact are captured as annotations (crosshair cursor, hover preview) instead of driving the artifact. Off: the artifact behaves natively and nothing is intercepted. The human turns it on to point at targets, off to use the prototype - the chosen answer to "annotate any element" vs "keep native controls working", since a script cannot detect an artifact's own click handlers.
_Avoid_: edit-mode, select-mode, inspect-mode

### The loop

**Feedback**:
One human submission - a message together with its attached annotations and a DOM snapshot - produced by a single "Send to Agent"; the session queues 0..N pending Feedback, and a poll drains them all at once as a TOON collection.
_Avoid_: prompt (collides with the LLM sense), message, comment

**DOM snapshot**:
The serialized live DOM of the artifact (`document.documentElement.outerHTML`) captured inside the iframe at Send and carried up the Bridge as part of a Feedback - the rendered document the human annotated and the one the annotation selectors resolve against, which diverges from the artifact's on-disk source for any interactive artifact.
_Avoid_: source, file contents (the on-disk bytes served at `/s/:key/source` are a separate thing)

**Poll**:
The agent's long-poll command (`intervu poll <file>`) that blocks silently until the human acts, then returns queued feedback as TOON. A Poll settles for one of three reasons - feedback was queued, a bounded `--timeout` expired (`timedOut`), or the Session ended (`ended`, which may carry a final feedback in the same return when the human used **Send & end**). A Poll that starts on an already-`ended` Session returns `ended` immediately rather than blocking. Safe to kill and re-run with no loss.
_Avoid_: wait, watch, listen

**End**:
The transition of a Session to `ended` status, driven by the human from the chrome - a top-bar **End session** control (ends now, no message), or **Send & end** which posts a final **Feedback** and ends in one atomic step - or by the agent from the terminal with `intervu end <file>` (no final-feedback rider). The chrome uses `POST /s/:key/end` (key-addressed, optional feedback rider) and the CLI uses `POST /end` (path-addressed, lookup-without-create), both over one core: the handler applies the optional final feedback and the status flip to the store before signalling, so a waiting Poll drains the final feedback and observes `ended` in the same settle. Persisted; idempotent (ending an `ended` Session is a no-op). Reversible: re-opening the path resurrects the Session to `open`.
_Avoid_: close, cancel, finish; **stop** (which shuts the whole daemon down, not one Session)

**Agent-reply**:
A message the agent posts into the human's conversation panel (via `poll --agent-reply "<msg>"`) to explain what it changed; the agent-to-human direction of the conversation.
_Avoid_: response, answer

**Conversation**:
The daemon-owned, in-memory ordered thread of the human's Feedback messages and the agent's Agent-replies for one Session - the single source of truth (#7), replayed to the chrome on SSE-stream connect and then appended live; the chrome renders the conversation panel purely from this, never from optimistic local state.
_Avoid_: thread, transcript, history, chat

**Presence**:
A human-facing indicator of the agent's state in the review loop: `idle` (no agent poll is open), `listening` (an agent poll is open and ready to receive feedback now), or `working` (the agent has taken feedback and is not currently polling).
_Avoid_: status, online/offline, waiting

**SSE stream**:
The single server-to-browser push channel (#7): a `text/event-stream` response off `SessionHub` at `/s/:key/events`, carrying JSON frames for the three server-driven pushes - live-reload nudges, Conversation appends (the human's Feedback messages and the agent's Agent-replies), and Presence changes. Replays the Conversation log on connect via `Last-Event-ID`. A separate path from both the Bridge (iframe<->chrome) and the poll (server-to-agent).
_Avoid_: connection, socket, websocket; the **Bridge** (a different path); TOON (this wire is JSON, not TOON)

### Output and design

**Home view**:
The content-first view printed on a bare `intervu` invocation (no subcommand): the `bin`, a one-line description, the live Sessions, and a next-step help line. "Live" means `open` Sessions only - `ended` ones are history and are omitted. The CLI reads them straight from the persisted state file (`SessionPersistence.load`), never from the daemon, so the view needs no running daemon and makes zero network calls. Each row carries `{key, path, status}`; `path` is the handle the help line tells the agent to `poll`.
_Avoid_: help text, dashboard, status screen; do not confuse with the **Chrome** (the browser review UI).

**TOON**:
Token-Oriented Object Notation - the published compact, schema-aware encoding of the JSON data model (the `@toon-format/toon` package) that intervu emits for all CLI output. Used encode-only; nothing in intervu parses TOON back.
_Avoid_: "Token-Optimized Object Notation" (the spec's word is "Oriented"); JSON output

**AXI**:
The set of 10 agent-ergonomic CLI design principles documented in axi.md, and the class of CLIs built to them: content-first TOON output, a no-argument home view instead of help text, contextual `help` next-step lines, and structured errors on stdout. intervu is one AXI implementation.
_Avoid_: MCP (intervu is a CLI, not an MCP server)

### The server lifecycle

**Daemon**:
The single shared background HTTP server (ADR 0002) that solely owns Session state, bound to loopback on the fixed default port, started on demand by a client and adopted across respawns from the persisted state file. The CLI is a thin HTTP client to it.
_Avoid_: server process, service, background process; the **`server` command** (`intervu server`) is the foreground invocation that *is* the daemon, not a separate thing.

**Takeover**:
The lifecycle move where a strictly-newer `intervu` client, finding a stale older-version daemon answering `/health` on the port, evicts it - SIGTERM via the shared `server.pid`, wait for the port to free - and spawns its own, so the agent never ends up talking to old code; an equal-or-newer running daemon is reused untouched (the older client "steps aside"). The direction is one predicate: take over iff the running version is strictly less than the client's; an unparseable running version counts as stale.
_Avoid_: restart, upgrade, kill, replace; **stop** (a deliberate shutdown with no replacement).

**Live connection**:
Any long-lived request a client holds open against the daemon - an agent's open **poll** or a browser's **SSE stream** (both pass through `SessionHub.subscribe`). The daemon tracks their global count in a reactive gauge and is "idle" exactly when that count is zero (no poll open and no tab connected anywhere).
_Avoid_: socket, request, connection-to-a-Session; a **Session** persists with zero live connections.

**Idle shutdown**:
The daemon reclaiming itself: one watcher fiber races a grace sleep (default 30s, `INTERVU_IDLE_TIMEOUT`) against the **live-connection** count and shuts the daemon down once that count has stayed zero for the whole grace window, so a respawned-but-unwatched or cleanly-ended daemon never dangles. A single unified condition (`connections == 0`): a terminal **End** with no tab open reclaims through the same timer, not a separate immediate path, and the grace window covers the spawn->first-connect gap so startup is safe.
_Avoid_: timeout, auto-stop, reap; **stop** (deliberate) and **Takeover** (replacement by a newer client).

### Discovery

**Skill**:
intervu's agent-facing description of the review loop - a markdown document authored in intervu's own vocabulary that **Setup** installs where Claude Code discovers skills (the user-level `~/.claude/skills/intervu/SKILL.md`), so an agent knows the loop (open or resume a **Session**, **poll** for **Feedback**, read the **annotations** and **DOM snapshot**, edit the **artifact**, reply with an **agent-reply**, **End**) without the human reciting it. Carried baked inside the single binary (ADR 0007), so Setup writes it out with no source tree present.
_Avoid_: prompt (collides with the LLM sense), guide, instructions, docs

**Setup**:
The one-command wiring (`intervu setup`) that makes intervu discoverable to the agent: it installs the **Skill** where Claude Code finds skills and registers the session-start **Hook**, and reports, as content-first TOON, for each half whether it was installed-now or already-present and where. Writes to the user-level `~/.claude` by default so discovery is global across projects; `--project` retargets both halves to the current repo's `.claude`, and `--skill-only` / `--hooks-only` wire one half without the other (ADR 0017). Idempotent: re-running is a clean no-op (a byte-identical Skill is not rewritten, and an already-present Hook is left in place), and the settings merge is schema-checked and no-clobber - it never overwrites a config file it cannot decode. Preconditioned on a resolvable `intervu`: because the Skill and Hook both shell out to a bare `intervu`, setup refuses (`IntervuNotOnPath`) before any write when no `intervu` is on `PATH`, so a transient `bunx` run never leaves a Skill and Hook pointing at a command that does not exist - a global install (`bun add -g intervu`) is the supported path (ADR 0019).
_Avoid_: install, configure, init (the command is `setup`); **Takeover** (a daemon-lifecycle move, unrelated)

**Hook (session-start / ambient context)**:
The `SessionStart` entry that **Setup** merges into Claude Code's settings file (`~/.claude/settings.json`) so the harness runs bare `intervu` at session start and injects its **Home view** - the live `open` **Sessions** plus the one-line description - as ambient context, so a fresh agent session already knows which reviews are waiting with zero extra calls. Fires once when the session begins, not per turn (ADR 0017); the payload reuses the Home view as-is, whose no-daemon, no-network, persisted-state-only read (ADR 0013) is exactly what a session-start hook needs to stay fast and side-effect-free. Recognized as intervu's own by its `intervu` command, which is how the merge stays idempotent.
_Avoid_: per-prompt hook (it fires at session start only), prompt (collides with the LLM sense); do not confuse the **Skill** (the loop's description) with the Hook (the ambient surfacing of live Sessions).

## Relationships

- A **Session** wraps one **artifact**, shown inside the **chrome**.
- The **artifact** iframe and the **chrome** communicate only through the **Bridge**; the human's **annotations** cross it from iframe to chrome, and removals cross back.
- The human captures **annotations** only while the **chrome** is in **Annotate-mode**; turning it off returns the **artifact** to native behavior.
- The human attaches **annotations** to the **artifact** and sends them with a message as one **feedback**; the agent drains queued feedback via **poll** and answers with an **agent-reply**.
- The human **End**s a **Session** from the chrome - the top-bar End control (ends now), or **Send & end** (posts a final **Feedback** and ends atomically); the agent's current or next **Poll** observes the `ended` status and stops. Re-opening the path resurrects the Session.
- **Presence** reflects the agent's state across the **poll** lifecycle of a **Session**.
- Every CLI command renders its result as **TOON** (a string passes through raw; an object is `encode`d); **AXI** is the design discipline, **TOON** the output format it mandates.
- The **Home view** lists the `open` **Sessions** read straight from the persisted state file, so a bare `intervu` needs no daemon and shows no **Presence** (a daemon-only signal); an `ended` Session is omitted, and an empty list is an explicit empty-state, not an error.
- The loop's three transports are distinct paths: the **Bridge** carries iframe<->chrome, the **poll** carries server->agent (feedback out), and the **SSE stream** carries server->browser (reload, **Conversation** appends, **Presence**).
- The **daemon** starts on demand and reclaims itself three ways: **Takeover** evicts a stale older daemon (a newer client replacing it), **Idle shutdown** retires an unwatched one (zero **live connections** for the grace window), and **stop** ends it deliberately (human or agent).
- A **live connection** is an open **poll** or **SSE stream**; **Presence** and **Idle shutdown** both read the daemon's connection accounting but answer different questions - agent activity for one Session vs. is-anyone-here across the whole daemon.
- **Setup** installs the **Skill** and registers the session-start **Hook** so the agent reaches for intervu on its own and a fresh session already knows which reviews are live; this extends intervu's **AXI** conformance from runtime ergonomics to discoverability - the Skill is the agent-facing description of the loop, the Hook injects the **Home view** as ambient context.

## Example dialogue

> **Agent:** "I wrote `report.html` and ran `intervu report.html`. A browser tab opened with my artifact inside the chrome. Now I'm on `intervu poll report.html`, blocked - presence shows **listening**."
> **Human:** "I click the third card; its selector is captured as an **annotation**. I select that card's heading and add a second annotation, type 'tighten these two', and Send. That is one **feedback**."
> **Agent:** "My poll returns that feedback as TOON - both annotations with their selectors, plus the DOM snapshot. Presence flips to **working** while I edit the file and the browser live-reloads. I poll again with `--agent-reply \"tightened both\"`, and presence returns to **listening**."

## Flagged ambiguities

- "prompt" was used (in `SessionStore.queuePrompts`) for what the user stories call **Feedback**. Resolved: the concept is **Feedback**; "prompt" is retired to avoid colliding with the LLM-prompt sense, and the store op becomes `queueFeedback` / `takeFeedback`.
- **Presence** had two conflicting state triples: story #10 said listening/working/idle, `SessionHub` said listening/working/waiting. Resolved: the canonical states are **idle / listening / working** (human-facing); "waiting" is retired as the agent's-eye view of **listening**.
- **Session** key was described as "content-addressed", but the agent live-edits the artifact, so a content-derived key would break mid-review. Resolved: the key is **path-based** - `hash(realpath(artifact))` - stable across edits; identical content at two paths is two Sessions; renaming an artifact mid-review is not a supported flow.
- **TOON** is defined as the format for "all CLI output", but the **SSE stream** (#7) is browser-facing, consumed by `EventSource`/JS. Resolved: TOON is the **CLI stdout** format only; the SSE channel carries **JSON** frames. "All output is TOON" scopes to the CLI, not the browser wire.
- `ended` is a **Session** status, not a **Presence** value. Presence stays the three agent-states (idle / listening / working); when a Session ends, the chrome stops showing Presence and renders an "Ended" pill in the same top-bar region. Resolved: do not add `ended` as a fourth Presence - ended is Session lifecycle, Presence is agent activity. They are pushed as distinct **SSE stream** frames (`PresenceChanged` vs `SessionEnded`).
- "idle" is overloaded across two scopes. **Presence** `idle` is a per-Session agent state (no agent **poll** open) shown in the chrome; the daemon's idle (the **Idle shutdown** condition) is global and counts *both* polls and **SSE streams**. Resolved: a Session can read Presence `idle` (agent not polling) while a browser tab keeps a **live connection** open, so the daemon is *not* idle. Presence `idle` = agent-not-polling (one Session); daemon-idle = zero live connections (whole daemon). Different scope, different inputs.
