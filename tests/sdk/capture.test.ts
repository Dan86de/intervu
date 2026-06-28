/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "@effect/vitest";
import {
  buildElementAnnotation,
  buildTextAnnotation,
  extractContext,
  resolveElementAnchor,
  resolveSelectionAnchor,
  truncateSelection,
} from "../../src/sdk/capture.ts";

/**
 * The pure capture logic the SDK owns, exercised under happy-dom: anchor
 * resolution from a click target and from a selection range, context/selection
 * truncation, and annotation construction with stub selector/id sources.
 * `@medv/finder` is not re-tested - the selector is injected here.
 */

const stubSelector = (_element: Element): string => "stub-selector";
const stubId = (): string => "stub-id";

describe("resolveElementAnchor", () => {
  it("returns the element for an element target", () => {
    const div = document.createElement("div");
    expect(resolveElementAnchor(div)).toBe(div);
  });

  it("returns null for a non-element target", () => {
    expect(resolveElementAnchor(null)).toBeNull();
    expect(resolveElementAnchor(document)).toBeNull();
  });
});

describe("resolveSelectionAnchor", () => {
  it("returns null for a collapsed range", () => {
    const p = document.createElement("p");
    const textNode = document.createTextNode("Hello world");
    p.append(textNode);
    document.body.append(p);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.collapse(true);
    expect(resolveSelectionAnchor(range)).toBeNull();
    p.remove();
  });

  it("returns the parent element when the common ancestor is a text node", () => {
    const p = document.createElement("p");
    const textNode = document.createTextNode("Hello world");
    p.append(textNode);
    document.body.append(p);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    expect(resolveSelectionAnchor(range)).toBe(p);
    p.remove();
  });

  it("returns the element itself when it is the common ancestor", () => {
    const container = document.createElement("div");
    container.innerHTML = "<span>a</span><span>b</span>";
    document.body.append(container);
    const range = document.createRange();
    range.selectNodeContents(container);
    expect(resolveSelectionAnchor(range)).toBe(container);
    container.remove();
  });
});

describe("extractContext", () => {
  it("collapses whitespace and trims", () => {
    const el = document.createElement("div");
    el.textContent = "  Hello\n   world  ";
    expect(extractContext(el)).toBe("Hello world");
  });

  it("returns an empty string for an empty element", () => {
    expect(extractContext(document.createElement("div"))).toBe("");
  });

  it("ellipsises text past the 120-char limit", () => {
    const el = document.createElement("div");
    el.textContent = "a".repeat(200);
    const context = extractContext(el);
    expect(context).toHaveLength(120);
    expect(context.endsWith("…")).toBe(true);
  });

  it("leaves text at the limit untouched", () => {
    const el = document.createElement("div");
    el.textContent = "a".repeat(120);
    expect(extractContext(el)).toBe("a".repeat(120));
  });
});

describe("truncateSelection", () => {
  it("collapses whitespace and ellipsises past the limit", () => {
    expect(truncateSelection("  pick   me  ")).toBe("pick me");
    expect(truncateSelection("b".repeat(200))).toHaveLength(120);
  });
});

describe("buildElementAnnotation", () => {
  it("constructs an element annotation from the anchor", () => {
    const button = document.createElement("button");
    button.textContent = "Subscribe";
    const annotation = buildElementAnnotation(button, stubSelector, stubId);
    expect(annotation).toEqual({
      kind: "element",
      id: "stub-id",
      selector: "stub-selector",
      tag: "button",
      text: "Subscribe",
    });
  });
});

describe("buildTextAnnotation", () => {
  it("constructs a text annotation carrying the selected run", () => {
    const p = document.createElement("p");
    p.textContent = "The quick brown fox";
    const annotation = buildTextAnnotation(
      p,
      "  quick  brown  ",
      stubSelector,
      stubId,
    );
    expect(annotation).toEqual({
      kind: "text",
      id: "stub-id",
      selector: "stub-selector",
      tag: "p",
      text: "The quick brown fox",
      selectedText: "quick brown",
    });
  });
});
