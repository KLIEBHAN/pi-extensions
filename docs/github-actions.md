# GitHub Actions dependency policy

All third-party workflow actions are pinned to immutable commit SHAs. [`.github/actions-lock.json`](../.github/actions-lock.json) is the single source of truth for the reviewed release version, SHA, JavaScript runtime, and immutable `action.yml` URL.

`test/workflow-actions.test.ts` enforces that:

- every external action used by a workflow has a lock entry,
- every workflow and reusable-workflow call uses the locked 40-character commit SHA rather than a movable tag,
- alternate valid YAML forms cannot bypass the structural scan,
- Docker action images are prohibited until an equivalent immutable digest-lock policy exists,
- every locked JavaScript action was reviewed as using the Node 24 action runtime, and
- stale, unused lock entries are rejected.

This policy covers the runtime used internally by an action. It is independent of the Node.js versions exercised by the repository's test matrix.

## Updating an action

1. Select an official release from the action's GitHub repository and read its release and migration notes.
2. Resolve the release to its commit SHA and verify the commit signature:

   ```bash
   gh api repos/actions/<action>/commits/<version> \
     --jq '{sha, verified: .commit.verification.verified}'
   ```

3. Fetch `action.yml` from that immutable SHA and verify `runs.using: node24`:

   ```bash
   gh api "repos/actions/<action>/contents/action.yml?ref=<sha>" \
     --jq '.content | @base64d'
   ```

4. Update every workflow reference and the corresponding `.github/actions-lock.json` entry in the same commit.
5. Run the offline policy tests, full repository checks, and Actionlint:

   ```bash
   node --experimental-strip-types --test test/workflow-actions.test.ts
   npm run check
   npm audit
   actionlint .github/workflows/*.yml
   ```

Do not weaken the runtime assertion merely to accept an older action. Upgrade the action instead. When GitHub moves beyond Node 24, update the policy, lock metadata, tests, and this document together after verifying the replacement runtime.
