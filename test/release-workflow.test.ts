import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(projectRoot, ".github", "workflows", "release-prompt-autocomplete.yml"), "utf8");

test("release recovery is pinned to main and shares the tag concurrency group", () => {
  assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*tag:/);
  assert.match(workflow, /RELEASE_TAG:.*inputs\.tag.*github\.ref_name/);
  assert.match(workflow, /group: release-.*inputs\.tag.*github\.ref_name/);
  assert.match(workflow, /\[ "\$GITHUB_REF" != "refs\/heads\/main" \]/);
  assert.match(workflow, /git diff --quiet "\$RELEASE_TAG\^\{\}" HEAD -- extensions\/prompt-autocomplete README\.md/);
});

test("privileged publish checks explicit E404 and fails closed on other lookup errors", () => {
  assert.match(workflow, /npm view "\$package@\$version" dist\.integrity --json >"\$registry_dir\/stdout" 2>"\$registry_dir\/stderr"/);
  assert.match(workflow, /elif grep -Eq '[^']*npm error code E404[^']*' "\$registry_dir\/stdout" "\$registry_dir\/stderr"; then/);
  assert.doesNotMatch(workflow, /404 Not Found|is not in this registry|could not be found/);
  assert.match(workflow, /Could not determine whether \$package@\$version exists; refusing to publish\./);
  assert.doesNotMatch(workflow, /if registry_json=.*npm view/);
});

test("release artifacts are run-scoped and publish uses the validated release tag", () => {
  assert.equal((workflow.match(/prompt-autocomplete-release-\$\{\{ github\.run_id \}\}/g) ?? []).length, 2);
  assert.match(workflow, /assert\.equal\(process\.env\.RELEASE_TAG, `pi-prompt-autocomplete-v\$\{item\.version\}`\)/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG"/);
  assert.match(workflow, /gh release edit "\$RELEASE_TAG" --draft=false/);
});

test("validated artifacts outlive multi-day protected-environment approvals", () => {
  const match = workflow.match(
    /name: prompt-autocomplete-release-\$\{\{ github\.run_id \}\}[\s\S]*?retention-days:\s*(\d+)/,
  );
  assert.ok(match, "release artifact upload must declare a retention period");

  const retentionDays = Number(match[1]);
  assert.ok(retentionDays >= 30, `release artifact retention must be at least 30 days, got ${retentionDays}`);
  assert.ok(retentionDays <= 90, `release artifact retention must not exceed GitHub's standard maximum, got ${retentionDays}`);
});
