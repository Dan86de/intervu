# Annotation capture is gated by an Annotate-mode toggle, not a per-click element-type heuristic

## Status

accepted

## Context and decision

Issue #5 asks that clicking any element annotate it while native controls (links, inputs, buttons) keep working.
The literal reading is a per-click **type heuristic**: intercept clicks on non-interactive elements, let semantic controls through.

That heuristic cannot work for the common modern artifact.
A page script has no way to detect an `addEventListener`-attached click handler - there is no standard DOM API, and `getEventListeners` is devtools-only.
Agent-generated artifacts frequently put their real interactivity on plain `<div>`s wired up by a framework, so a type heuristic would classify them as non-interactive, annotate them, and `preventDefault`/`stopPropagation` the click - **swallowing the prototype's behavior**, the exact thing user story #7 forbids.
The heuristic also leaves no way to annotate a button, link, or input, yet "make this button bigger" is a core review comment.

Decision: capture is gated by an explicit **Annotate-mode** toggle in the chrome.
Off (default): the artifact is fully itself, nothing is intercepted, every native and framework-driven handler works.
On: crosshair cursor plus a hover preview, and any click annotates that element (controls included) while a drag-select annotates text.
The chrome sends the mode to the in-iframe SDK over the bridge (`set-mode`).

This deviates from #5's literal acceptance criterion 3: clicking a link performs its native action and creates no annotation **only while annotate-mode is off**; in annotate-mode, clicking a link annotates it.

## Considered options

- **Annotate-mode toggle** - chosen: no per-click heuristic, so the undetectable-handler problem disappears entirely; the prototype stays fully usable when off; anything is annotatable when on; the one modal cost is mitigated by an obvious crosshair cursor and toggle state.
- **Per-click type heuristic** (the literal spec) - rejected: silently swallows framework-driven `<div>` interactivity (handlers are undetectable) and cannot annotate semantic controls at all.
- **Modifier-gated** (Alt/Option+click annotates, plain clicks always pass through) - rejected: poor discoverability (nothing on screen signals the gesture) and awkward text-selection disambiguation (select-to-copy vs select-to-annotate).

## Consequences

- The chrome owns the mode toggle; the bridge carries a `set-mode` message (chrome to iframe).
- Issue #5's acceptance criteria are reframed around the mode - criterion 3 holds while annotate-mode is off.
- In annotate-mode the artifact is not interactive (clicking a control annotates instead of acting); the crosshair cursor and toggle state keep the mode unmistakable.
