import { expect, test } from "@playwright/test";
import {
  armAnnotate,
  artifactFrame,
  dragSelectText,
  openArtifact,
} from "./support.ts";

/**
 * The annotate-mode capture loop end to end (issue #5): with the mode on, a
 * click and a text drag-select each become a selector-based annotation - marked
 * in the iframe's Shadow DOM overlay and listed as a numbered pending row in the
 * chrome - and the same gesture no longer drives the artifact. Stacked
 * annotations renumber, and removing a row clears its in-artifact marker.
 */

test.beforeEach(async ({ page, request, baseURL }) => {
  await openArtifact(page, request, baseURL ?? "");
});

test("clicking an element annotates it and suppresses the native action", async ({
  page,
}) => {
  const frame = artifactFrame(page);
  const rows = page.locator("[data-pending-list] li");
  await expect(rows).toHaveCount(0);
  await expect(page.locator("[data-pending-empty]")).toBeVisible();

  await armAnnotate(page);
  await frame.locator("#native-btn").click();

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-kind", "element");
  await expect(rows.first().locator("[data-badge]")).toHaveText("1");
  await expect(rows.first()).toContainText("<button>");
  // One marker rendered in the iframe's shadow overlay.
  await expect(frame.locator(".marker")).toHaveCount(1);
  // The native inline handler did not run - the click was captured, not acted on.
  await expect(frame.locator("#native-btn")).toHaveText("Press me");
});

test("drag-selecting text annotates the selection", async ({ page }) => {
  const frame = artifactFrame(page);
  const rows = page.locator("[data-pending-list] li");

  await armAnnotate(page);
  await dragSelectText(page, frame.locator("#pick"));

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-kind", "text");
  await expect(rows.first()).toContainText("brown");
  await expect(frame.locator(".marker")).toHaveCount(1);
});

test("annotations stack and removing a row clears its marker", async ({
  page,
}) => {
  const frame = artifactFrame(page);
  const rows = page.locator("[data-pending-list] li");

  await armAnnotate(page);
  await frame.locator("#native-btn").click();
  await frame.locator("#second-btn").click();

  await expect(rows).toHaveCount(2);
  await expect(frame.locator(".marker")).toHaveCount(2);
  await expect(rows.nth(0).locator("[data-badge]")).toHaveText("1");
  await expect(rows.nth(1).locator("[data-badge]")).toHaveText("2");

  await rows.first().getByRole("button", { name: "Remove annotation" }).click();

  await expect(rows).toHaveCount(1);
  await expect(frame.locator(".marker")).toHaveCount(1);
  // The survivor renumbers from 2 to 1, staying in step with its marker badge.
  await expect(rows.first().locator("[data-badge]")).toHaveText("1");
});
