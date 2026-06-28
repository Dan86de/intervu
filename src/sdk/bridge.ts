import {
  type Annotation,
  BRIDGE_NAMESPACE,
  type BridgeEnvelope,
  type BridgeMessage,
} from "./protocol.ts";

/**
 * The runtime postMessage plumbing across the artifact iframe's opaque-origin
 * boundary (ADR 0003). Both sides wrap a message in a namespaced envelope and
 * authenticate the peer by frame reference - the artifact is sandboxed without
 * `allow-same-origin`, so every message arrives with `event.origin === "null"`
 * and an origin check would be meaningless. Shared by the SDK (running inside
 * the iframe) and the chrome controller (running in the top window).
 */

const isAnnotateMode = (value: unknown): boolean =>
  value === "on" || value === "off";

const isAnnotation = (value: unknown): value is Annotation => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    !("kind" in value) ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("selector" in value) ||
    typeof value.selector !== "string" ||
    !("tag" in value) ||
    typeof value.tag !== "string" ||
    !("text" in value) ||
    typeof value.text !== "string"
  ) {
    return false;
  }
  if (value.kind === "element") {
    return true;
  }
  if (value.kind === "text") {
    return "selectedText" in value && typeof value.selectedText === "string";
  }
  return false;
};

const isBridgeMessage = (value: unknown): value is BridgeMessage => {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  if (value.kind === "set-mode") {
    return "mode" in value && isAnnotateMode(value.mode);
  }
  if (value.kind === "annotation-added") {
    return "annotation" in value && isAnnotation(value.annotation);
  }
  if (value.kind === "annotation-removed") {
    return "id" in value && typeof value.id === "string";
  }
  return false;
};

const isBridgeEnvelope = (value: unknown): value is BridgeEnvelope => {
  if (typeof value !== "object" || value === null || !("ns" in value)) {
    return false;
  }
  if (value.ns !== BRIDGE_NAMESPACE) {
    return false;
  }
  return "message" in value && isBridgeMessage(value.message);
};

/**
 * Chrome -> iframe: deliver a Bridge message into the artifact frame. The target
 * origin is `"*"` because the frame is opaque-origin; the receiving SDK
 * authenticates the sender by frame reference, so the wildcard leaks nothing.
 */
export const postToFrame = (frame: Window, message: BridgeMessage): void => {
  const envelope: BridgeEnvelope = { ns: BRIDGE_NAMESPACE, message };
  frame.postMessage(envelope, "*");
};

/**
 * Iframe -> chrome: deliver a Bridge message up to the parent window. The target
 * origin is `"*"` for the same opaque-origin reason; the chrome authenticates
 * the sender by matching `event.source` against the artifact's frame.
 */
export const postToParent = (message: BridgeMessage): void => {
  const envelope: BridgeEnvelope = { ns: BRIDGE_NAMESPACE, message };
  window.parent.postMessage(envelope, "*");
};

/**
 * Iframe side: subscribe to Bridge messages from the chrome, accepting only
 * those whose `event.source` is the parent window (frame-reference auth) and
 * whose payload is a well-formed namespaced envelope. Returns an unsubscribe.
 */
export const onMessageFromParent = (
  handler: (message: BridgeMessage) => void,
): (() => void) => {
  const listener = (event: MessageEvent): void => {
    if (event.source !== window.parent) {
      return;
    }
    const data: unknown = event.data;
    if (!isBridgeEnvelope(data)) {
      return;
    }
    handler(data.message);
  };
  window.addEventListener("message", listener);
  return () => {
    window.removeEventListener("message", listener);
  };
};

/**
 * Chrome side: subscribe to Bridge messages from one artifact iframe, accepting
 * only those whose `event.source` is that iframe's content window (the mirror of
 * the iframe-side parent check) and whose payload is a valid envelope. Returns
 * an unsubscribe.
 */
export const onMessageFromFrame = (
  iframe: HTMLIFrameElement,
  handler: (message: BridgeMessage) => void,
): (() => void) => {
  const listener = (event: MessageEvent): void => {
    if (event.source === null || event.source !== iframe.contentWindow) {
      return;
    }
    const data: unknown = event.data;
    if (!isBridgeEnvelope(data)) {
      return;
    }
    handler(data.message);
  };
  window.addEventListener("message", listener);
  return () => {
    window.removeEventListener("message", listener);
  };
};
