# Artifact iframe is sandboxed to an opaque origin; the chrome is reached only by postMessage

## Status

accepted

## Context and decision

The chrome and the artifact are served by the same loopback daemon, so by default they would share an origin.
To make CONTEXT.md's guarantee true *by construction* - the artifact "cannot reach or break the chrome except through the postMessage bridge" - the artifact iframe is sandboxed **without `allow-same-origin`** (tokens: `allow-scripts allow-forms allow-popups`), which gives it a unique opaque origin.
Cross-origin policy then blocks the artifact's own scripts from touching `parent.document`, while `postMessage` and asset subresource loads keep working (the sandbox gates origin-privileged APIs, not the network).

## Considered options

- **Opaque origin (omit `allow-same-origin`)** - chosen: isolation holds by construction with one server on one origin; the artifact still runs its own scripts, forms, and links, and can read its own DOM (the in-iframe SDK needs this).
- **`allow-same-origin`, same host** - rejected: the artifact is genuinely same-origin and can call `parent.document.*` to rewrite or delete the chrome, so the isolation guarantee becomes a lie.
- **`allow-same-origin` on a distinct origin** (chrome on `127.0.0.1`, iframe on `localhost` - different host strings, so cross-origin on the same daemon/port) - rejected for the MVP: it would preserve both isolation and full same-origin artifact functionality, but it depends on `localhost` resolving to the bound loopback (IPv4/IPv6 edge cases) and still prevents the chrome from reading the iframe DOM, so it buys nothing over the opaque origin here.

## Consequences

- The postMessage bridge (next slice) will receive messages with `event.origin === "null"`; it must validate the sender by frame reference, not by origin string.
- Artifacts that rely on same-origin browser features (e.g. `localStorage`, `IndexedDB`, some canvas operations) may behave differently inside the opaque-origin iframe than they would standalone.
- This slice's "copy DOM snapshot" control cannot read the cross-origin iframe DOM, so it copies the artifact's served **source HTML** (`GET /s/:key/source`, un-injected); it upgrades to the live post-JS DOM once the bridge exists.
