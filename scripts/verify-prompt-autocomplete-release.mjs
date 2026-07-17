import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(root, "extensions", "prompt-autocomplete");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const changelog = readFileSync(resolve(packageRoot, "CHANGELOG.md"), "utf8");
const readme = readFileSync(resolve(packageRoot, "README.md"), "utf8");
const rootReadme = readFileSync(resolve(root, "README.md"), "utf8");
const video = readFileSync(resolve(packageRoot, "media", "prompt-autocomplete-demo.mp4"));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const expectedTag = `pi-prompt-autocomplete-v${manifest.version}`;
const releaseVideoUrl = `https://github.com/KLIEBHAN/pi-extensions/releases/download/${expectedTag}/prompt-autocomplete-demo.mp4`;
const suppliedTag = process.argv[2]
  ?? process.env.RELEASE_TAG
  ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);

assert.equal(manifest.name, "@kliebhan/pi-prompt-autocomplete");
assert.equal(manifest.private, undefined);
assert.equal(manifest.publishConfig?.access, "public");
assert.equal(manifest.publishConfig?.provenance, true);
assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
assert.ok(manifest.keywords?.includes("pi-package"));
assert.equal(manifest.repository?.directory, "extensions/prompt-autocomplete");
assert.match(changelog, new RegExp(`^## \\[${escapeRegex(manifest.version)}\\]`, "m"));
assert.match(readme, /Privacy, providers, and cost/);
assert.match(readme, /disabled by default/i);
assert.equal(manifest.pi?.video, releaseVideoUrl);
assert.ok(readme.includes(releaseVideoUrl), "standalone README must use the versioned Gallery video URL");
assert.ok(rootReadme.includes(releaseVideoUrl), "root README must use the versioned Gallery video URL");
assert.ok(video.length >= 10_000, "Gallery video is unexpectedly small");
assert.equal(video.subarray(4, 8).toString("ascii"), "ftyp", "Gallery video is not an MP4 file");

if (suppliedTag) {
  assert.equal(suppliedTag, expectedTag, `release tag must be ${expectedTag}`);
}

console.log(`Release metadata valid for ${manifest.name}@${manifest.version} (${expectedTag})`);
