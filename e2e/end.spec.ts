import { expect, test } from "@playwright/test";
import {
  armAnnotate,
  artifactFrame,
  openPath,
  tempArtifact,
} from "./support.ts";

/**
 * Ending a review from the page, end to end (issue #8). The reviewer closes the
 * loop from the chrome - the top-bar End session control, or the composer's
 * Send & end - and a waiting `poll` settles with `ended` (carrying the final
 * feedback when Send & end was used). The chrome then reflects the ended state
 * over the SSE stream: an "Ended" pill replaces presence, the composer becomes
 * the ended note, and the Annotate and End controls disable, while the artifact
 * stays visible and frozen. Each spec uses its own temp artifact for isolation.
 */

test("the top-bar End ends a waiting poll and freezes the chrome", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("end-plain");
  await openPath(page, request, base, file);

  // A poll is listening before the human ends.
  const poll = request.post(`${base}/poll`, {
    data: { path: file },
    timeout: 30_000,
  });

  const end = page.locator("[data-end-session]");
  await expect(end).toBeEnabled();
  await end.click();

  // The waiting poll settles with `ended` and no final feedback.
  const response = await poll;
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    timedOut: false,
    ended: true,
    feedback: [],
  });

  // The chrome reflects the ended state, SSE-driven.
  await expect(page.locator("[data-ended-pill]")).toBeVisible();
  await expect(page.locator("[data-presence]")).toBeHidden();
  await expect(page.locator("[data-composer]")).toBeHidden();
  await expect(page.locator("[data-ended-note]")).toBeVisible();
  await expect(page.locator("[data-annotate-toggle]")).toBeDisabled();
  await expect(end).toBeDisabled();
  // The artifact stays visible and frozen.
  await expect(artifactFrame(page).locator("#headline")).toHaveText(
    "end-plain",
  );
});

test("Send & end delivers the final feedback and ends in one poll", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("end-send");
  await openPath(page, request, base, file);

  const poll = request.post(`${base}/poll`, {
    data: { path: file },
    timeout: 30_000,
  });

  // Annotate an element, type a final message, then Send & end.
  await armAnnotate(page);
  await artifactFrame(page).locator("#native-btn").click();
  await expect(page.locator("[data-pending-list] li")).toHaveCount(1);
  await page.locator("[data-composer-input]").fill("final tweak");
  const sendEnd = page.locator("[data-send-end]");
  await expect(sendEnd).toBeEnabled();
  await sendEnd.click();

  // The same poll settles once with the final feedback AND `ended` (ADR 0011).
  const response = await poll;
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    timedOut: false,
    ended: true,
    feedback: [
      {
        message: "final tweak",
        annotations: [{ kind: "element", tag: "button" }],
      },
    ],
  });

  // The final human message landed in the thread before the chrome froze.
  await expect(page.locator("[data-conversation] [data-seq]")).toContainText(
    "final tweak",
  );
  await expect(page.locator("[data-ended-pill]")).toBeVisible();
  await expect(page.locator("[data-composer]")).toBeHidden();
});

test("a poll on an already-ended session returns at once; feedback is rejected", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("end-already");
  const key = await openPath(page, request, base, file);

  // End from the page (no poll waiting), then confirm the chrome froze.
  await page.locator("[data-end-session]").click();
  await expect(page.locator("[data-ended-pill]")).toBeVisible();

  // A poll that starts on an already-ended session returns immediately.
  const response = await request.post(`${base}/poll`, {
    data: { path: file },
    timeout: 30_000,
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ ended: true, feedback: [] });

  // Feedback to an ended session is rejected server-side (defense-in-depth).
  const rejected = await request.post(`${base}/s/${key}/feedback`, {
    data: {
      message: "too late",
      annotations: [],
      domSnapshot: "<html></html>",
    },
  });
  expect(rejected.status()).toBe(409);
});
