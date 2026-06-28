import {
  type APIRequestContext,
  expect,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * Shared E2E helpers: open a session for the committed fixture and drive the
 * annotate-mode gestures the way a reviewer does. The artifact iframe is a
 * sandboxed opaque origin, so the in-iframe SDK announces its readiness only by
 * the `data-intervu-mode` attribute it writes on `<html>`; raw `page.mouse`
 * gestures wait on that signal first (frameLocator `.click()` auto-waits on its
 * own actionability and needs no extra gate).
 */

/** The absolute path of the committed fixture, the artifact under review. */
export const fixturePath = new URL("./fixtures/artifact.html", import.meta.url)
  .pathname;

/** The in-iframe SDK marks `<html>` with its current Annotate-mode. */
const modeSelector = (mode: "on" | "off"): string =>
  `html[data-intervu-mode="${mode}"]`;

/** The artifact iframe, located in the chrome by its data hook. */
export const artifactFrame = (page: Page): FrameLocator =>
  page.frameLocator("[data-artifact]");

/** Open a session for the fixture and navigate to its chrome page. */
export const openArtifact = async (
  page: Page,
  request: APIRequestContext,
  baseURL: string,
): Promise<void> => {
  const response = await request.post(`${baseURL}/sessions`, {
    data: { path: fixturePath },
  });
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  const key =
    typeof body === "object" &&
    body !== null &&
    "key" in body &&
    typeof body.key === "string"
      ? body.key
      : null;
  expect(key).not.toBeNull();
  await page.goto(`${baseURL}/s/${key}`);
  // The SDK has loaded inside the iframe once it has stamped the mode attribute.
  await artifactFrame(page).locator(modeSelector("off")).waitFor();
};

/** Turn Annotate-mode on and wait for the SDK to reflect it inside the iframe. */
export const armAnnotate = async (page: Page): Promise<void> => {
  const toggle = page.locator("[data-annotate-toggle]");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await artifactFrame(page).locator(modeSelector("on")).waitFor();
};

/** A non-null bounding box for `locator`, failing the test if it has none. */
const boxOf = async (
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const box = await locator.boundingBox();
  expect(box, "expected the element to have a bounding box").not.toBeNull();
  if (box === null) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return box;
};

/** Drag-select the text of `locator` with a raw mouse gesture. */
export const dragSelectText = async (
  page: Page,
  locator: Locator,
): Promise<void> => {
  const box = await boxOf(locator);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 6 });
  await page.mouse.up();
};
