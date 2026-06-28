import { chmodSync } from "node:fs";

/**
 * Bundle the CLI into a single executable ESM file at `dist/intervu`.
 *
 * The bundle targets Bun because the entrypoint wires the Bun platform services
 * (`BunServices` / `BunRuntime`), so the emitted file carries a `bun` shebang
 * and the executable bit.
 */
const outPath = "dist/intervu";

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  target: "bun",
  format: "esm",
});

if (!result.success) {
  for (const message of result.logs) {
    console.error(message);
  }
  process.exit(1);
}

const artifact = result.outputs[0];
if (artifact === undefined) {
  console.error("build produced no output artifact");
  process.exit(1);
}

const code = await artifact.text();
await Bun.write(outPath, `#!/usr/bin/env bun\n${code}`);
chmodSync(outPath, 0o755);

console.error(`built ${outPath}`);
