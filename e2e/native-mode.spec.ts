import { expect, test } from "@playwright/test";
import { artifactFrame, openArtifact } from "./support.ts";

/**
 * Annotate-mode off is the default and the artifact must be fully itself (issue
 * #5, ADR 0006): a click runs the artifact's own handler and creates no
 * annotation. This is the criterion that holds the prototype usable - capture is
 * gated by the toggle, never a per-click heuristic.
 */

test("with annotate-mode off, a click runs the native handler and annotates nothing", async ({
  page,
  request,
  baseURL,
}) => {
  await openArtifact(page, request, baseURL ?? "");
  const frame = artifactFrame(page);
  const rows = page.locator("[data-pending-list] li");

  // The toggle starts off; do not arm it.
  await expect(page.locator("[data-annotate-toggle]")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await frame.locator("#native-btn").click();

  // The artifact's inline onclick ran, and no annotation was captured.
  await expect(frame.locator("#native-btn")).toHaveText("clicked");
  await expect(rows).toHaveCount(0);
  await expect(frame.locator(".marker")).toHaveCount(0);
});
