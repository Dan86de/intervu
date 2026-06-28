import { expect, test } from "@playwright/test";
import {
  armAnnotate,
  artifactFrame,
  fixturePath,
  openArtifact,
} from "./support.ts";

/**
 * The core collaboration loop end to end (issue #6): with a `poll` listening, the
 * reviewer annotates an element, types a message, and hits Send to Agent - and
 * the long-poll resolves with that exact Feedback (message, the annotation's
 * selector/tag, and a live DOM snapshot). On success the composer, the pending
 * rows, and the in-artifact markers clear. This is the tracer bullet proving the
 * whole concept: point at an element, send, agent receives the target.
 */

test("Send to Agent delivers the message and target to a waiting poll", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  await openArtifact(page, request, base);

  // A poll is already listening before the human sends.
  const pollResponse = request.post(`${base}/poll`, {
    data: { path: fixturePath },
    timeout: 30_000,
  });

  // Annotate an element, type a message, and Send.
  await armAnnotate(page);
  await artifactFrame(page).locator("#native-btn").click();
  const rows = page.locator("[data-pending-list] li");
  await expect(rows).toHaveCount(1);

  const composer = page.locator("[data-composer-input]");
  await composer.fill("tighten this button");
  const send = page.locator("[data-send]");
  await expect(send).toBeEnabled();
  await send.click();

  // The poll resolves with the message, the exact target, and a DOM snapshot.
  const response = await pollResponse;
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  // The wire Feedback carries no badge number (the poll's `n` is CLI-shaper-only)
  // - just the selector context, plus the live DOM the human annotated.
  expect(body).toMatchObject({
    timedOut: false,
    feedback: [
      {
        message: "tighten this button",
        annotations: [
          {
            kind: "element",
            tag: "button",
            selector: expect.any(String),
          },
        ],
        domSnapshot: expect.stringContaining("native-btn"),
      },
    ],
  });

  // A successful Send clears the composer, the rows, and the marker.
  await expect(rows).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(send).toBeDisabled();
  await expect(artifactFrame(page).locator(".marker")).toHaveCount(0);
});
