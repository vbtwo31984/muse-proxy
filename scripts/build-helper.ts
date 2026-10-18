// Bundles the Muse Helper (and the publisher tool) into single dependency-free .mjs files.
import { build } from "esbuild";
import { chmodSync } from "node:fs";

for (const [entry, outfile] of [
  ["src/helper/cli.ts", "dist/muse-helper.mjs"],
  ["src/publisher/cli.ts", "dist/muse-publish.mjs"],
] as const) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    minify: false,
    legalComments: "none",
    logLevel: "warning",
  });
  chmodSync(outfile, 0o755);
  console.log(`built ${outfile}`);
}
