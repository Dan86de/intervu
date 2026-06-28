import * as fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  armAnnotate,
  artifactFrame,
  artifactHtml,
  openPath,
  tempArtifact,
} from "./support.ts";

/**
 * The server-to-browser push slice end to end (issue #7): everything the daemon
 * pushes back to the browser rides one SSE channel off `SessionHub`. These specs
 * drive the four acceptance criteria - live-reload in place, agent-reply into the
 * panel, one merged Conversation thread, and the listening/working/idle Presence
 * indicator - each against its own temp artifact so a unique Session keeps the
 * parallel specs isolated.
 */

/** Arm annotate, capture one element, type a message, and Send to Agent. */
const sendFeedback = async (page: Page, message: string): Promise<void> => {
  await armAnnotate(page);
  await artifactFrame(page).locator("#native-btn").click();
  await expect(page.locator("[data-pending-list] li")).toHaveCount(1);
  await page.locator("[data-composer-input]").fill(message);
  const send = page.locator("[data-send]");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.locator("[data-composer-input]")).toHaveValue("");
};

test("presence reflects listening then working, all over one SSE channel", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("presence");

  const eventStreams: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/events")) {
      eventStreams.push(req.url());
    }
  });

  await openPath(page, request, base, file);
  const label = page.locator("[data-presence-label]");
  await expect(label).toHaveText("idle");

  // A poll opens: presence flips to listening over the SSE channel.
  const poll = request.post(`${base}/poll`, {
    data: { path: file },
    timeout: 30_000,
  });
  await expect(label).toHaveText("listening");

  // Sending feedback delivers to the poll and closes it: presence -> working.
  await sendFeedback(page, "tighten the heading");
  const response = await poll;
  expect(response.ok()).toBe(true);
  await expect(label).toHaveText("working");

  // The human message arrived as a thread bubble on that same one connection.
  await expect(page.locator("[data-conversation] [data-seq]")).toContainText(
    "tighten the heading",
  );
  expect(eventStreams).toHaveLength(1);
});

test("editing the artifact reloads only the iframe in place", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("VERSION ONE");

  const eventStreams: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/events")) {
      eventStreams.push(req.url());
    }
  });

  await openPath(page, request, base, file);
  await expect(artifactFrame(page).locator("#headline")).toHaveText(
    "VERSION ONE",
  );

  // A sentinel on the top window proves the chrome itself never reloads.
  await page.evaluate(() => {
    document.title = "kept";
  });
  // Arm annotate so we can prove the mode survives a reload.
  await armAnnotate(page);

  // Edit the artifact on disk: the iframe live-reloads in place.
  fs.writeFileSync(file, artifactHtml("VERSION TWO"));
  await expect(artifactFrame(page).locator("#headline")).toHaveText(
    "VERSION TWO",
    { timeout: 15_000 },
  );

  // The chrome did not reload (sentinel survives), annotate-mode was re-applied
  // to the fresh document, and the reload rode the one already-open SSE channel.
  expect(await page.title()).toBe("kept");
  await artifactFrame(page)
    .locator('html[data-intervu-mode="on"]')
    .waitFor({ timeout: 15_000 });
  expect(eventStreams).toHaveLength(1);
});

test("agent-reply posts into the panel and the poll keeps waiting", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("reply");
  await openPath(page, request, base, file);

  // No feedback is queued, so this poll posts its reply then blocks.
  const poll = request.post(`${base}/poll`, {
    data: { path: file, agentReply: "tightened both", timeoutSeconds: 30 },
    timeout: 30_000,
  });

  const bubbles = page.locator("[data-conversation] [data-seq]");
  await expect(bubbles).toHaveCount(1);
  await expect(bubbles.nth(0)).toContainText("tightened both");
  await expect(bubbles.nth(0)).toContainText("Agent");

  // It really kept waiting: feedback sent now resolves the still-open poll.
  await sendFeedback(page, "now the spacing");
  const response = await poll;
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  expect(body).toMatchObject({
    timedOut: false,
    feedback: [{ message: "now the spacing" }],
  });
});

test("agent replies and reviewer messages read as one thread", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("thread");
  await openPath(page, request, base, file);

  // The reviewer sends first (human bubble, right-aligned).
  await sendFeedback(page, "make it bolder");
  const bubbles = page.locator("[data-conversation] [data-seq]");
  await expect(bubbles).toHaveCount(1);
  await expect(bubbles.nth(0)).toContainText("Human");
  await expect(bubbles.nth(0)).toContainText("make it bolder");

  // The agent replies via poll --agent-reply (agent bubble, left-aligned). The
  // poll also drains the queued feedback and returns; the thread keeps both.
  const response = await request.post(`${base}/poll`, {
    data: { path: file, agentReply: "made it bolder", timeoutSeconds: 30 },
    timeout: 30_000,
  });
  expect(response.ok()).toBe(true);

  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.nth(1)).toContainText("Agent");
  await expect(bubbles.nth(1)).toContainText("made it bolder");
});
