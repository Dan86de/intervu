# The chrome is built with Tailwind v4 (compiled at build time) and shadcn tokens; the artifact keeps its own CSS

## Status

accepted

## Context and decision

Issue #4 shipped the chrome with minimal hand-rolled CSS and explicitly deferred the "Tailwind/DaisyUI design-system ladder."
That ladder is a different feature - injecting a CSS framework *into the user's artifact* as a styling fallback (#1, out of scope) - not how intervu's own view is built.

Issue #5 grows the chrome from a static shell into real interactive UI: the annotate-mode toggle, the conversation/chat area, and the annotation stack rows.
To build that consistently, the chrome adopts **Tailwind v4 plus the shadcn design-token system and component conventions**, authored as plain markup and utility classes (no React - shadcn here means its tokens and visual language, applied by hand).

Tailwind is **compiled at build time** into a small static stylesheet the daemon serves (baked into the single-file binary), **not** the in-browser runtime.
The browser runtime (`@tailwindcss/browser`) ships the Oxide compiler as a multi-megabyte WASM payload; intervu already has a build, and every class the chrome uses is statically present in its own source, so a build-time scan yields the identical result at a few kilobytes, fully offline, with no runtime compiler.

This supersedes #4's "minimal hand-rolled CSS" line **for the chrome only**.
The artifact iframe stays untouched - it ships with its own CSS, with no Tailwind imposed (consistent with ADR 0003).
This is intervu styling *its own view*, not the artifact; the deferred artifact-styling ladder (#1) remains out of scope.

## Considered options

- **Tailwind v4 compiled at build time into static CSS** - chosen: the same utility authoring and shadcn tokens, a few kilobytes, fully offline, no runtime WASM, and it keeps the single-file ship lean.
- **Tailwind v4 browser runtime** (vendored or CDN) - rejected: a multi-megabyte WASM payload to bake into or serve alongside a loopback tool, with no benefit since all chrome classes are statically present in source.
- **Keep #4's minimal hand-rolled CSS** - rejected: the chrome now carries enough interactive surface that a real token system plus utilities pays off in consistency and velocity.
- **DaisyUI** - not chosen: shadcn's token approach is the selected design language.

## Consequences

- Chrome classes must be **statically present** in `src/chrome/**` source and the rendered markup, so the build-time scan captures them; no dynamically computed class-name strings.
- "shadcn" in this codebase means the token and visual system applied to hand-written elements, not imported React components.
- In-iframe annotation markers do **not** use Tailwind (see ADR 0005); they are shadow-scoped hand-authored styles that mirror the shadcn look.
