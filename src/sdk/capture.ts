import type { ElementAnnotation, TextAnnotation } from "./protocol.ts";

/**
 * The pure DOM logic behind annotation capture (CONTEXT.md "Annotation"): given
 * a click target or a selection range, resolve the element to anchor to, extract
 * its surrounding context, and construct the selector-based annotation. Kept
 * free of the Bridge, the Shadow DOM overlay, and `@medv/finder` so it is
 * deterministic and unit-testable under happy-dom; the selector generator and id
 * minter are injected by the SDK entry point. happy-dom can't drive the real
 * mouse-and-selection event flow, so that wiring is covered by the Playwright
 * E2E in a later slice - these functions are the part worth asserting in unit.
 */

/** Cap on the surrounding-context string; longer text is ellipsised. */
const CONTEXT_LIMIT = 120;

/** Mints the stable id for an annotation (injected so tests stay deterministic). */
export type IdSource = () => string;

/** Produces a stable CSS selector for an element (the `@medv/finder` wrapper). */
export type SelectorSource = (element: Element) => string;

/** Collapse runs of whitespace and trim, then ellipsise past `CONTEXT_LIMIT`. */
const truncate = (value: string): string => {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > CONTEXT_LIMIT
    ? `${collapsed.slice(0, CONTEXT_LIMIT - 1)}…`
    : collapsed;
};

/**
 * The element to annotate for a click: the target itself when it is an element,
 * otherwise none. Returning `null` lets the caller ignore clicks that did not
 * land on an element (e.g. the bare document).
 */
export const resolveElementAnchor = (
  target: EventTarget | null,
): Element | null => (target instanceof Element ? target : null);

/**
 * The element to anchor a text selection to: the range's common ancestor when it
 * is itself an element, otherwise that node's parent element. A collapsed range
 * (a plain click, not a drag-select) resolves no anchor so the caller falls back
 * to element capture.
 */
export const resolveSelectionAnchor = (range: Range): Element | null => {
  if (range.collapsed) {
    return null;
  }
  const node = range.commonAncestorContainer;
  return node instanceof Element ? node : node.parentElement;
};

/** The anchor's truncated text content, the annotation's surrounding context. */
export const extractContext = (element: Element): string =>
  truncate(element.textContent ?? "");

/** A selected run of text, truncated to the same bound as the context. */
export const truncateSelection = (selectedText: string): string =>
  truncate(selectedText);

/** Construct an `element` annotation from a resolved anchor. */
export const buildElementAnnotation = (
  element: Element,
  makeSelector: SelectorSource,
  makeId: IdSource,
): ElementAnnotation => ({
  kind: "element",
  id: makeId(),
  selector: makeSelector(element),
  tag: element.tagName.toLowerCase(),
  text: extractContext(element),
});

/** Construct a `text` annotation from a resolved anchor and its selected text. */
export const buildTextAnnotation = (
  element: Element,
  selectedText: string,
  makeSelector: SelectorSource,
  makeId: IdSource,
): TextAnnotation => ({
  kind: "text",
  id: makeId(),
  selector: makeSelector(element),
  tag: element.tagName.toLowerCase(),
  text: extractContext(element),
  selectedText: truncateSelection(selectedText),
});
