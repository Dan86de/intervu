# Annotation markers render in a Shadow DOM overlay inside the artifact iframe, not as a chrome-side geometry overlay

## Status

accepted

## Context and decision

The annotation SDK (#5) shows a visual highlight on each annotated element (and a hover preview of the current target).
That highlight has to stay aligned with an element that scrolls and reflows *inside* the iframe.

The marker is rendered by the already-injected in-iframe SDK (the `<script src="/sdk.js">` from #4) into a **Shadow DOM overlay**: a single shadow host appended to the artifact document, with its own encapsulated styles that mirror the shadcn look.
Because the overlay is shadow-encapsulated it adds **zero CSS to the artifact's cascade**, and the artifact's CSS cannot reach in to restyle it - so ADR 0003's "the artifact renders exactly as standalone" guarantee still holds: the artifact's *styling* is untouched; we add one isolated shadow tree, not a stylesheet change.

## Considered options

- **Shadow DOM overlay inside the iframe** - chosen: the highlight lives in the same document as the target, so it tracks scroll, reflow, and transforms for free, while shadow encapsulation keeps the artifact cascade pristine.
- **Chrome-side overlay positioned over the iframe** from geometry streamed across the bridge - rejected: keeps the artifact DOM literally untouched but must continuously re-sync each highlight on scroll/resize and breaks down with nested scroll containers and CSS transforms (drift and jitter).
- **Plain (non-shadow) DOM injected into the artifact** - rejected: markers would inherit the artifact's styles and could leak styles back into it.

## Consequences

- The SDK appends exactly one shadow host to the artifact body; all marker UI lives inside that shadow root and is excluded from being an annotation target itself.
- Marker styles are hand-authored and shadow-scoped (not Tailwind; see ADR 0004), and mirror the shadcn aesthetic.
- The bridge carries annotation *data*, not per-frame geometry; the artifact's own scroll and layout are unaffected by the overlay.
