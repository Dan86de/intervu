import { Effect } from "effect";

/**
 * Open the OS default browser at `url`, detached so the spawned process outlives
 * this CLI. This is the human's entry into the review surface: the tab renders
 * the artifact inside intervu's chrome at the per-session `/s/:key` route.
 */
export const openTab = (url: string): Effect.Effect<void> =>
  Effect.sync(() => {
    const command =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    const child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
  });
