import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The browser container's Playwright server must speak the same protocol version as
// the app's playwright-core client. Dependabot bumps package.json only.
test("browser.Dockerfile matches playwright-core", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
  const want = pkg.dependencies["playwright-core"];
  const dockerfile = readFileSync("deploy/browser.Dockerfile", "utf8");
  assert.equal(dockerfile.match(/^FROM mcr\.microsoft\.com\/playwright:v([\d.]+)-/m)?.[1], want, "FROM image tag");
  assert.equal(dockerfile.match(/npm install -g playwright@([\d.]+)/)?.[1], want, "npm install -g playwright@");
});
