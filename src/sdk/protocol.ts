/**
 * The Bridge wire contract shared by the in-iframe SDK and the chrome controller
 * (CONTEXT.md "Bridge"; ADR 0003). Pure data with no DOM types, so the daemon
 * can import these shapes at the server boundary too; the runtime postMessage
 * plumbing that carries them lives in `bridge.ts`. The artifact iframe is
 * sandboxed to an opaque origin, so a received message always carries
 * `event.origin === "null"` - peers are authenticated by frame reference, never
 * by origin string.
 */

/**
 * Namespace stamped on every Bridge envelope so unrelated `postMessage` traffic
 * - browser extensions, the artifact's own libraries - is ignored on receipt.
 */
export const BRIDGE_NAMESPACE = "intervu/bridge/v1";

/** Whether the chrome's Annotate-mode is currently capturing (ADR 0006). */
export type AnnotateMode = "on" | "off";

/**
 * Chrome -> iframe: set the artifact's capture mode. The only Bridge message in
 * this slice; the annotation messages (`annotation-added`, `annotation-removed`)
 * extend this union when click/text capture lands.
 */
export interface SetModeMessage {
  readonly kind: "set-mode";
  readonly mode: AnnotateMode;
}

/** Every payload the Bridge can carry, in either direction. */
export type BridgeMessage = SetModeMessage;

/** The namespaced envelope wrapping every Bridge message on the wire. */
export interface BridgeEnvelope {
  readonly ns: typeof BRIDGE_NAMESPACE;
  readonly message: BridgeMessage;
}
