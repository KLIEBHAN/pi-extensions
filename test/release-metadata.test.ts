import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");
const packageFiles = ["package.json", "CHANGELOG.md", "README.md", "media/prompt-autocomplete-demo.mp4"];

/** Run the release metadata check against a copy whose 0.3.x heading is replaced. */
function verifyWithHeading(heading: string, tag?: string) {
  const root = mkdtempSync(join(tmpdir(), "prompt-autocomplete-release-metadata-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const script of ["verify-prompt-autocomplete-release.mjs", "prompt-autocomplete-support.mjs"]) {
      copyFileSync(join(projectRoot, "scripts", script), join(root, "scripts", script));
    }
    copyFileSync(join(projectRoot, "README.md"), join(root, "README.md"));
    const packageRoot = join(root, "extensions", "prompt-autocomplete");
    mkdirSync(join(packageRoot, "media"), { recursive: true });
    for (const file of packageFiles) {
      copyFileSync(join(projectRoot, "extensions", "prompt-autocomplete", file), join(packageRoot, file));
    }
    const version = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
    const changelog = readFileSync(join(packageRoot, "CHANGELOG.md"), "utf8");
    const current = new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\].*$`, "m");
    assert.match(changelog, current);
    writeFileSync(join(packageRoot, "CHANGELOG.md"), changelog.replace(current, `## [${version}]${heading}`));

    return spawnSync(
      process.execPath,
      [join(root, "scripts", "verify-prompt-autocomplete-release.mjs"), ...(tag ? [tag.replace("VERSION", version)] : [])],
      { encoding: "utf8", env: { ...process.env, RELEASE_TAG: "", GITHUB_REF_TYPE: "" } },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("development metadata may keep an Unreleased changelog heading", () => {
  const result = verifyWithHeading(" - Unreleased");
  assert.equal(result.status, 0, result.stderr);
});

test("a tagged release requires a dated changelog heading", () => {
  const unreleased = verifyWithHeading(" - Unreleased", "pi-prompt-autocomplete-vVERSION");
  assert.notEqual(unreleased.status, 0);
  assert.match(unreleased.stderr, /a release must date its CHANGELOG heading/);

  for (const invalid of ["", " - 2026-13-01", " - 2026-02-30", " - soon"]) {
    const result = verifyWithHeading(invalid, "pi-prompt-autocomplete-vVERSION");
    assert.notEqual(result.status, 0, `"${invalid}" must not pass as a release date`);
  }

  const dated = verifyWithHeading(" - 2026-10-20", "pi-prompt-autocomplete-vVERSION");
  assert.equal(dated.status, 0, dated.stderr);
});

test("a release tag must match the package version", () => {
  const result = verifyWithHeading(" - 2026-10-20", "pi-prompt-autocomplete-v9.9.9");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release tag must be pi-prompt-autocomplete-v/);
});
