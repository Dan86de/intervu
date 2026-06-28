import {
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

const isBridgeMessage = (value: unknown): value is BridgeMessage => {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  if (value.kind !== "set-mode") {
    return false;
  }
  return "mode" in value && isAnnotateMode(value.mode);
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
