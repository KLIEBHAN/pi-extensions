import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

interface LockedAction {
  version: string;
  sha: string;
  runtime: string;
  metadata: string;
}

const projectRoot = resolve(import.meta.dirname, "..");
const workflowDirectory = resolve(projectRoot, ".github", "workflows");
const lock = JSON.parse(
  readFileSync(resolve(projectRoot, ".github", "actions-lock.json"), "utf8"),
) as Record<string, LockedAction>;

const workflowFiles = readdirSync(workflowDirectory)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();

function requireMapping(value: unknown, location: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${location} must be a mapping`);
  return value as Record<string, unknown>;
}

function verifyActionReference(
  file: string,
  location: string,
  value: unknown,
  usedActions: Set<string>,
): void {
  assert.equal(typeof value, "string", `${file}: ${location} must be a string`);
  const specifier = value as string;
  if (specifier.startsWith("./")) return;
  assert.ok(
    !specifier.startsWith("docker://"),
    `${file}: ${location} uses a Docker image; external images are prohibited until a digest-lock policy exists`,
  );

  const separator = specifier.lastIndexOf("@");
  assert.ok(separator > 0, `${file}: ${location} must pin an external action with @<sha>`);
  const action = specifier.slice(0, separator);
  const reference = specifier.slice(separator + 1);
  const entry = lock[action];
  assert.ok(entry, `${file}: ${location} uses unreviewed action ${action}`);
  assert.match(reference, /^[0-9a-f]{40}$/, `${file}: ${location} must use an immutable commit SHA`);
  assert.equal(reference, entry.sha, `${file}: ${location} does not match the reviewed ${action} SHA`);
  usedActions.add(action);
}

function verifyWorkflowSource(file: string, source: string, usedActions = new Set<string>()): Set<string> {
  const workflow = requireMapping(parse(source), file);
  const jobs = requireMapping(workflow.jobs, `${file}: jobs`);

  for (const [jobName, jobValue] of Object.entries(jobs)) {
    const job = requireMapping(jobValue, `${file}: jobs.${jobName}`);
    if (Object.hasOwn(job, "uses")) {
      verifyActionReference(file, `jobs.${jobName}.uses`, job.uses, usedActions);
    }

    if (job.steps === undefined) continue;
    assert.ok(Array.isArray(job.steps), `${file}: jobs.${jobName}.steps must be a sequence`);
    job.steps.forEach((stepValue, index) => {
      const step = requireMapping(stepValue, `${file}: jobs.${jobName}.steps[${index}]`);
      if (Object.hasOwn(step, "uses")) {
        verifyActionReference(file, `jobs.${jobName}.steps[${index}].uses`, step.uses, usedActions);
      }
    });
  }

  return usedActions;
}

test("workflow action lock contains immutable Node 24 metadata", () => {
  assert.ok(Object.keys(lock).length > 0, "workflow action lock must not be empty");

  for (const [action, entry] of Object.entries(lock)) {
    assert.match(action, /^[\w.-]+\/[\w.-]+$/, `invalid action name: ${action}`);
    assert.match(entry.version, /^v\d+\.\d+\.\d+$/, `${action} must record an exact release version`);
    assert.match(entry.sha, /^[0-9a-f]{40}$/, `${action} must use an immutable commit SHA`);
    assert.equal(entry.runtime, "node24", `${action}@${entry.version} must be verified as a Node 24 action`);
    assert.equal(
      entry.metadata,
      `https://raw.githubusercontent.com/${action}/${entry.sha}/action.yml`,
      `${action} must link to immutable upstream action metadata`,
    );
  }
});

test("every external workflow action matches the reviewed lock entry", () => {
  const usedActions = new Set<string>();

  for (const file of workflowFiles) {
    verifyWorkflowSource(file, readFileSync(resolve(workflowDirectory, file), "utf8"), usedActions);
  }

  assert.deepEqual([...usedActions].sort(), Object.keys(lock).sort(), "action lock contains unused entries");
});

test("workflow action policy parses alternate YAML forms and fails closed", () => {
  const cases: Array<[name: string, source: string, expected: RegExp]> = [
    [
      "named-step.yml",
      "jobs:\n  test:\n    steps:\n      - name: Checkout\n        uses: actions/checkout@main # mutable ref with words",
      /must use an immutable commit SHA/,
    ],
    [
      "flow-map.yml",
      "jobs:\n  test:\n    steps:\n      - { uses: actions/checkout@main }",
      /must use an immutable commit SHA/,
    ],
    [
      "quoted-key.yml",
      'jobs:\n  test:\n    steps:\n      - "uses": actions/checkout@main',
      /must use an immutable commit SHA/,
    ],
    [
      "spaced-key.yml",
      "jobs:\n  test:\n    steps:\n      - uses : actions/checkout@main",
      /must use an immutable commit SHA/,
    ],
    [
      "reusable.yml",
      "jobs:\n  shared:\n    uses: example/reusable-workflow@main",
      /uses unreviewed action example\/reusable-workflow/,
    ],
    [
      "docker.yml",
      "jobs:\n  test:\n    steps:\n      - uses: docker://example/image:latest",
      /external images are prohibited until a digest-lock policy exists/,
    ],
  ];

  for (const [name, source, expected] of cases) {
    assert.throws(() => verifyWorkflowSource(name, source), expected, name);
  }
});
