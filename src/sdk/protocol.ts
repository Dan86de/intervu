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
 * The selector-based marker the human attaches to a clicked element or a
 * selected run of text (CONTEXT.md "Annotation"; ADR 0005). A DOM-free
 * discriminated union so it crosses the Bridge as plain data and the server can
 * mirror it as a `Schema` at the boundary in #6. `id` is minted in the iframe
 * (`crypto.randomUUID()`); `selector` is the stable CSS path; `tag` and `text`
 * are the anchor's tag name and truncated surrounding context. There is no
 * geometry - annotations are selector-based only.
 */
export interface ElementAnnotation {
  readonly kind: "element";
  readonly id: string;
  readonly selector: string;
  readonly tag: string;
  readonly text: string;
}

/** A `text` annotation also carries the selected run of text it anchors to. */
export interface TextAnnotation {
  readonly kind: "text";
  readonly id: string;
  readonly selector: string;
  readonly tag: string;
  readonly text: string;
  readonly selectedText: string;
}

/** Either annotation kind; discriminated on `kind`. */
export type Annotation = ElementAnnotation | TextAnnotation;

/**
 * Chrome -> iframe: set the artifact's capture mode (ADR 0006). Off returns the
 * artifact to native behaviour; on takes the crosshair cursor and gates capture.
 */
export interface SetModeMessage {
  readonly kind: "set-mode";
  readonly mode: AnnotateMode;
}

/** Iframe -> chrome: the human captured a new annotation in the artifact. */
export interface AnnotationAddedMessage {
  readonly kind: "annotation-added";
  readonly annotation: Annotation;
}

/**
 * Chrome -> iframe: remove a stacked annotation by id (driven from its panel
 * row), which clears the matching in-artifact marker.
 */
export interface AnnotationRemovedMessage {
  readonly kind: "annotation-removed";
  readonly id: string;
}

/** Every payload the Bridge can carry, in either direction. */
export type BridgeMessage =
  | SetModeMessage
  | AnnotationAddedMessage
  | AnnotationRemovedMessage;

/** The namespaced envelope wrapping every Bridge message on the wire. */
export interface BridgeEnvelope {
  readonly ns: typeof BRIDGE_NAMESPACE;
  readonly message: BridgeMessage;
}
