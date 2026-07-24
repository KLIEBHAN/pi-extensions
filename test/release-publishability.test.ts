import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const checkScript = resolve(projectRoot, "scripts", "check-prompt-autocomplete-publishability.mjs");
const packageVersion = (JSON.parse(
  readFileSync(resolve(projectRoot, "extensions", "prompt-autocomplete", "package.json"), "utf8"),
) as { version: string }).version;

function runScenario(scenario: "exact" | "mismatch" | "missing" | "outage" | "misleading") {
  const tempRoot = mkdtempSync(join(tmpdir(), "prompt-autocomplete-publishability-"));
  const fakeNpm = join(tempRoot, "fake-npm.mjs");
  const callsPath = join(tempRoot, "calls.jsonl");

  writeFileSync(fakeNpm, `
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_CALLS, JSON.stringify(args) + "\\n");
const command = args[0];
const bytes = Buffer.from("deterministic release fixture");
const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
const packageVersion = ${JSON.stringify(packageVersion)};

if (command === "view") {
  if (process.env.FAKE_NPM_SCENARIO === "exact") {
    console.log(JSON.stringify(integrity));
    process.exit(0);
  }
  if (process.env.FAKE_NPM_SCENARIO === "mismatch") {
    console.log(JSON.stringify("sha512-different"));
    process.exit(0);
  }
  if (process.env.FAKE_NPM_SCENARIO === "missing") {
    console.error("npm error code E404\\nnpm error 404 Not Found");
    process.exit(1);
  }
  if (process.env.FAKE_NPM_SCENARIO === "misleading") {
    console.error("npm error code E503\\nnpm error upstream says 404 Not Found; package could not be found");
    process.exit(1);
  }
  console.error("npm error code E503\\nnpm error registry unavailable");
  process.exit(1);
}

if (command === "pack") {
  const destination = args[args.indexOf("--pack-destination") + 1];
  const filename = "kliebhan-pi-prompt-autocomplete-" + packageVersion + ".tgz";
  mkdirSync(destination, { recursive: true });
  writeFileSync(resolve(destination, filename), bytes);
  console.log(JSON.stringify([{
    name: "@kliebhan/pi-prompt-autocomplete",
    version: packageVersion,
    filename,
    integrity,
  }]));
  process.exit(0);
}

if (command === "publish" && process.env.FAKE_NPM_SCENARIO === "missing") {
  process.exit(0);
}

console.error("unexpected fake npm call", args);
process.exit(2);
`, "utf8");

  const result = spawnSync(process.execPath, [checkScript], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_execpath: fakeNpm,
      FAKE_NPM_CALLS: callsPath,
      FAKE_NPM_SCENARIO: scenario,
    },
  });
  const calls = readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);

  return {
    result,
    commands: calls.map((args) => args[0]),
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

test("publishability check accepts an existing byte-identical version without publishing", () => {
  const scenario = runScenario("exact");
  try {
    assert.equal(scenario.result.status, 0, scenario.result.stderr);
    assert.deepEqual(scenario.commands, ["view", "pack"]);
    assert.match(scenario.result.stdout, /exact local integrity/);
  } finally {
    scenario.cleanup();
  }
});

test("publishability check fails closed on an existing integrity mismatch", () => {
  const scenario = runScenario("mismatch");
  try {
    assert.notEqual(scenario.result.status, 0);
    assert.deepEqual(scenario.commands, ["view", "pack"]);
    assert.match(scenario.result.stderr, /already exists with different bytes/);
  } finally {
    scenario.cleanup();
  }
});

test("publishability check runs the dry-run only for an explicit E404", () => {
  const scenario = runScenario("missing");
  try {
    assert.equal(scenario.result.status, 0, scenario.result.stderr);
    assert.deepEqual(scenario.commands, ["view", "publish"]);
  } finally {
    scenario.cleanup();
  }
});

test("publishability check refuses to publish when the registry is unavailable", () => {
  const scenario = runScenario("outage");
  try {
    assert.notEqual(scenario.result.status, 0);
    assert.deepEqual(scenario.commands, ["view"]);
    assert.match(scenario.result.stderr, /registry unavailable/);
  } finally {
    scenario.cleanup();
  }
});

test("publishability check ignores misleading absence prose without an E404 code", () => {
  const scenario = runScenario("misleading");
  try {
    assert.notEqual(scenario.result.status, 0);
    assert.deepEqual(scenario.commands, ["view"]);
    assert.match(scenario.result.stderr, /code E503/);
  } finally {
    scenario.cleanup();
  }
});
