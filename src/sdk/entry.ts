import { onMessageFromParent, postToParent } from "./bridge.ts";
import {
  buildElementAnnotation,
  buildTextAnnotation,
  resolveElementAnchor,
  resolveSelectionAnchor,
} from "./capture.ts";
import { createOverlay } from "./overlay.ts";
import type { AnnotateMode, Annotation } from "./protocol.ts";
import { cssSelectorFor } from "./selector.ts";

/**
 * The in-iframe SDK (CONTEXT.md "Bridge"; ADR 0003 / 0005 / 0006), injected into
 * every artifact at `/sdk.js`. With Annotate-mode on it takes the crosshair
 * cursor, previews the element under the pointer, and turns clicks and drag-
 * selections into selector-based annotations: each is marked in a Shadow DOM
 * overlay and posted up to the chrome over the Bridge. A capture-phase click
 * suppressor keeps the artifact from acting on the same gesture (ADR 0006). With
 * the mode off nothing is intercepted and the artifact is fully itself; stacked
 * markers persist until the chrome removes them. The pure anchor/context/build
 * logic lives in `capture.ts`; this module is the event and Bridge wiring.
 */

const MODE_ATTRIBUTE = "data-intervu-mode";

const main = (): void => {
  const overlay = createOverlay();
  let capturing = false;

  const isInOverlay = (node: Node | null): boolean =>
    node !== null && (node === overlay.host || overlay.host.contains(node));

  const emit = (annotation: Annotation, anchor: Element): void => {
    overlay.addMarker(annotation.id, anchor);
    postToParent({ kind: "annotation-added", annotation });
  };

  const captureText = (selection: Selection): boolean => {
    if (selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }
    const anchor = resolveSelectionAnchor(selection.getRangeAt(0));
    if (anchor === null || isInOverlay(anchor)) {
      return false;
    }
    const annotation = buildTextAnnotation(
      anchor,
      selection.toString(),
      cssSelectorFor,
      () => crypto.randomUUID(),
    );
    emit(annotation, anchor);
    selection.removeAllRanges();
    return true;
  };

  const captureElement = (target: EventTarget | null): void => {
    const anchor = resolveElementAnchor(target);
    if (anchor === null || isInOverlay(anchor)) {
      return;
    }
    const annotation = buildElementAnnotation(anchor, cssSelectorFor, () =>
      crypto.randomUUID(),
    );
    emit(annotation, anchor);
  };

  // Capture-phase, on `window` so it runs ahead of artifact handlers: stop the
  // gesture from driving the artifact (navigation, submits, framework clicks).
  const onClick = (event: MouseEvent): void => {
    if (!capturing) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  // The annotation is built on mouseup, where the selection is finalized: a
  // non-collapsed selection is a text annotation, otherwise the click target is
  // an element annotation.
  const onMouseUp = (event: MouseEvent): void => {
    if (!capturing || event.button !== 0) {
      return;
    }
    const selection = window.getSelection();
    if (selection !== null && captureText(selection)) {
      return;
    }
    captureElement(event.target);
  };

  const onPointerMove = (event: MouseEvent): void => {
    if (!capturing) {
      return;
    }
    const target = event.target;
    overlay.previewTarget(
      target instanceof Element && !isInOverlay(target) ? target : null,
    );
  };

  const applyMode = (mode: AnnotateMode): void => {
    const root = document.documentElement;
    root.setAttribute(MODE_ATTRIBUTE, mode);
    root.style.cursor = mode === "on" ? "crosshair" : "";
    capturing = mode === "on";
    if (!capturing) {
      overlay.previewTarget(null);
    }
  };

  window.addEventListener("click", onClick, true);
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("mouseover", onPointerMove, true);

  applyMode("off");
  onMessageFromParent((message) => {
    if (message.kind === "set-mode") {
      applyMode(message.mode);
    } else if (message.kind === "annotation-removed") {
      overlay.removeMarker(message.id);
    } else if (message.kind === "snapshot-request") {
      // The live, rendered DOM the human annotated (ADR 0008) - the document
      // the annotation selectors resolve against, which diverges from the
      // on-disk source for any interactive artifact.
      postToParent({
        kind: "snapshot-result",
        html: document.documentElement.outerHTML,
      });
    }
  });
};

main();
