import { expect, test } from "@playwright/test";
import { openArtifact } from "./support.ts";

/**
 * The Bridge authenticates peers by frame reference, never by origin (ADR 0003):
 * the chrome accepts `annotation-added` only when `event.source` is the artifact
 * iframe's content window. A structurally valid envelope - correct namespace,
 * well-formed annotation - posted from any other source must be ignored, which
 * is what proves it is the frame-reference check doing the gating and not merely
 * the namespace filter. The accepted path (real iframe -> chrome) is covered by
 * `annotation.spec.ts`.
 */

test("a valid envelope from a non-iframe source is ignored", async ({
  page,
  request,
  baseURL,
}) => {
  await openArtifact(page, request, baseURL ?? "");
  const rows = page.locator("[data-pending-list] li");
  await expect(rows).toHaveCount(0);

  // Forge a well-formed annotation-added envelope and post it from the top
  // window to itself: `event.source` is the top window, not the iframe.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.postMessage(
          {
            ns: "intervu/bridge/v1",
            message: {
              kind: "annotation-added",
              annotation: {
                kind: "element",
                id: "forged-id",
                selector: "#forged",
                tag: "div",
                text: "forged context",
              },
            },
          },
          "*",
        );
        setTimeout(resolve, 50);
      }),
  );

  // The forged message produced no pending row; the chrome rejected the sender.
  await expect(rows).toHaveCount(0);
  await expect(page.locator("[data-pending-empty]")).toBeVisible();
});
