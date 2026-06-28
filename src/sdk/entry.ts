import { onMessageFromParent } from "./bridge.ts";
import type { AnnotateMode } from "./protocol.ts";

/**
 * The in-iframe SDK (CONTEXT.md "Bridge"; ADR 0003 / 0006), injected into every
 * artifact at `/sdk.js`. This slice wires the receive-half of the Bridge and
 * reflects Annotate-mode: when the chrome turns it on, the artifact takes the
 * crosshair cursor that signals "a click points at a target, it doesn't act".
 * Click and text capture, the selector + surrounding-context model, and the
 * Shadow DOM marker overlay build on this seam in the capture slice; nothing is
 * intercepted here, so the artifact stays fully itself.
 */

const MODE_ATTRIBUTE = "data-intervu-mode";

const applyMode = (mode: AnnotateMode): void => {
  const root = document.documentElement;
  root.setAttribute(MODE_ATTRIBUTE, mode);
  root.style.cursor = mode === "on" ? "crosshair" : "";
};

const main = (): void => {
  applyMode("off");
  onMessageFromParent((message) => {
    if (message.kind === "set-mode") {
      applyMode(message.mode);
    }
  });
};

main();
