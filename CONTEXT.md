# intervu

intervu is a local, AXI-style CLI that turns an agent-generated HTML artifact into a collaborative browser review surface: the human annotates the rendered page, and the agent long-polls for that feedback and live-edits the file.

## Language

### The review surface

**Artifact**:
The agent-generated HTML file - plus any sibling assets it references by relative path - that is under review.
_Avoid_: file, document, page

**Session**:
The review context for one artifact - its queue of pending feedback, its conversation (feedback and agent-replies), and a status (`open` -> ... -> `ended`) - identified by a key derived from the artifact's normalized absolute path (`hash(realpath)`), stable across the agent's edits so that re-running `open` on the same path resumes the same Session.
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
The agent's long-poll command (`intervu poll <file>`) that blocks silently until the human acts, then returns queued feedback as TOON; safe to kill and re-run with no loss.
_Avoid_: wait, watch, listen

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

**TOON**:
Token-Oriented Object Notation - the published compact, schema-aware encoding of the JSON data model (the `@toon-format/toon` package) that intervu emits for all CLI output. Used encode-only; nothing in intervu parses TOON back.
_Avoid_: "Token-Optimized Object Notation" (the spec's word is "Oriented"); JSON output

**AXI**:
The set of 10 agent-ergonomic CLI design principles documented in axi.md, and the class of CLIs built to them: content-first TOON output, a no-argument home view instead of help text, contextual `help` next-step lines, and structured errors on stdout. intervu is one AXI implementation.
_Avoid_: MCP (intervu is a CLI, not an MCP server)

## Relationships

- A **Session** wraps one **artifact**, shown inside the **chrome**.
- The **artifact** iframe and the **chrome** communicate only through the **Bridge**; the human's **annotations** cross it from iframe to chrome, and removals cross back.
- The human captures **annotations** only while the **chrome** is in **Annotate-mode**; turning it off returns the **artifact** to native behavior.
- The human attaches **annotations** to the **artifact** and sends them with a message as one **feedback**; the agent drains queued feedback via **poll** and answers with an **agent-reply**.
- **Presence** reflects the agent's state across the **poll** lifecycle of a **Session**.
- Every CLI command renders its result as **TOON** (a string passes through raw; an object is `encode`d); **AXI** is the design discipline, **TOON** the output format it mandates.
- The loop's three transports are distinct paths: the **Bridge** carries iframe<->chrome, the **poll** carries server->agent (feedback out), and the **SSE stream** carries server->browser (reload, **Conversation** appends, **Presence**).

## Example dialogue

> **Agent:** "I wrote `report.html` and ran `intervu report.html`. A browser tab opened with my artifact inside the chrome. Now I'm on `intervu poll report.html`, blocked - presence shows **listening**."
> **Human:** "I click the third card; its selector is captured as an **annotation**. I select that card's heading and add a second annotation, type 'tighten these two', and Send. That is one **feedback**."
> **Agent:** "My poll returns that feedback as TOON - both annotations with their selectors, plus the DOM snapshot. Presence flips to **working** while I edit the file and the browser live-reloads. I poll again with `--agent-reply \"tightened both\"`, and presence returns to **listening**."

## Flagged ambiguities

- "prompt" was used (in `SessionStore.queuePrompts`) for what the user stories call **Feedback**. Resolved: the concept is **Feedback**; "prompt" is retired to avoid colliding with the LLM-prompt sense, and the store op becomes `queueFeedback` / `takeFeedback`.
- **Presence** had two conflicting state triples: story #10 said listening/working/idle, `SessionHub` said listening/working/waiting. Resolved: the canonical states are **idle / listening / working** (human-facing); "waiting" is retired as the agent's-eye view of **listening**.
- **Session** key was described as "content-addressed", but the agent live-edits the artifact, so a content-derived key would break mid-review. Resolved: the key is **path-based** - `hash(realpath(artifact))` - stable across edits; identical content at two paths is two Sessions; renaming an artifact mid-review is not a supported flow.
- **TOON** is defined as the format for "all CLI output", but the **SSE stream** (#7) is browser-facing, consumed by `EventSource`/JS. Resolved: TOON is the **CLI stdout** format only; the SSE channel carries **JSON** frames. "All output is TOON" scopes to the CLI, not the browser wire.
