import { finder } from "@medv/finder";

/**
 * The `@medv/finder` wrapper: a stable, unique CSS selector for an element
 * (issue #5). Selector generation - uniqueness, anchor preference, escaping - is
 * a solved problem we delegate, so this is the only file that touches finder and
 * the unit tests never re-test it. finder throws when it cannot produce a
 * selector (e.g. a detached node); we fall back to the bare tag name rather than
 * propagate, mirroring the chrome controller's graceful-degradation idiom.
 */
export const cssSelectorFor = (element: Element): string => {
  try {
    return finder(element);
  } catch {
    return element.tagName.toLowerCase();
  }
};
