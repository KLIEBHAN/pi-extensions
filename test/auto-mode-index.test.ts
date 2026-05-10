import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import typescript from "typescript";
import { AUTO_MODE_STATE_TYPE } from "../extensions/auto-mode/core.ts";

let autoModeModulePromise: Promise<{ default: Function; createAutoModeExtension: Function }> | undefined;

async function loadAutoModeModuleFromSource(options: {
  piAiStubSource?: string;
  transformSource?: (source: string) => string;
} = {}) {
  const rawSource = readFileSync(new URL("../extensions/auto-mode/index.ts", import.meta.url), "utf8");
  const source = options.transformSource ? options.transformSource(rawSource) : rawSource;
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022,
      moduleResolution: typescript.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
    },
    fileName: "index.ts",
  }).outputText;

  const tempDir = mkdtempSync(join(tmpdir(), "auto-mode-index-test-"));
  const piAiStubPath = join(tempDir, "pi-ai.mjs");
  writeFileSync(
    piAiStubPath,
    options.piAiStubSource
      ?? 'export async function complete() { throw new Error("complete should not be called in auto-mode index tests"); }\n',
  );

  const coreUrl = new URL("../extensions/auto-mode/core.ts", import.meta.url).href;
  const rewritten = transpiled
    .replace(/@mariozechner\/pi-ai/g, pathToFileURL(piAiStubPath).href)
    .replace(/\.\/core\.ts/g, coreUrl);

  const modulePath = join(tempDir, "index.mjs");
  writeFileSync(modulePath, rewritten);
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`) as Promise<{ default: Function; createAutoModeExtension: Function }>;
}

async function loadAutoModeModule() {
  autoModeModulePromise ??= loadAutoModeModuleFromSource();
  return autoModeModulePromise;
}

function createHarness(
  initialFlags: Record<string, boolean | string | undefined> = {},
  initialEntries: unknown[] = [],
  execImpl?: (
    command: string,
    args: string[],
    options: Record<string, unknown> | undefined,
  ) => Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>,
  appendEntryImpl?: (customType: string, data: unknown) => void,
) {
  const flags = new Map(Object.entries(initialFlags));
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  const entries = [...initialEntries];
  const sentMessages: Array<{ text: string; options?: unknown }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const execCalls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];
  let sessionName: string | undefined;
  let aborted = false;

  const pi = {
    registerFlag() {},
    registerCommand(name: string, command: { handler: Function }) {
      commands.set(name, command);
    },
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    appendEntry(customType: string, data: unknown) {
      if (appendEntryImpl) {
        appendEntryImpl(customType, data);
        return;
      }
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(text: string, options?: unknown) {
      sentMessages.push({ text, options });
      entries.push({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
      });
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(value: string) {
      sessionName = value;
    },
    exec: async (command: string, args: string[], options?: Record<string, unknown>) => {
      execCalls.push({ command, args, options });
      return execImpl?.(command, args, options) ?? { code: 0, stdout: "", stderr: "" };
    },
  };

  const ctx = {
    cwd: "/repo",
    signal: new AbortController().signal,
    model: { provider: "openai", id: "gpt-worker" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    sessionManager: {
      getBranch: () => entries,
    },
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
    },
    isIdle: () => true,
    abort: () => {
      aborted = true;
    },
  };

  return { pi, handlers, commands, entries, sentMessages, notifications, statuses, execCalls, ctx, get aborted() { return aborted; } };
}

function getLatestAutoState(entries: unknown[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
    if (!entry || entry.type !== "custom") continue;
    if (entry.customType !== AUTO_MODE_STATE_TYPE) continue;
    return entry.data as Record<string, unknown>;
  }
  return undefined;
}

function countAutoStateEntries(entries: unknown[]): number {
  return entries.filter((entry) => {
    const customEntry = entry as { type?: unknown; customType?: unknown };
    return customEntry.type === "custom" && customEntry.customType === AUTO_MODE_STATE_TYPE;
  }).length;
}

test("default export is a callable extension entry", async () => {
  const autoModeModule = await loadAutoModeModule();
  assert.equal(typeof autoModeModule.default, "function");
  assert.equal(typeof autoModeModule.createAutoModeExtension, "function");
});

test("session_start keeps the completion gate controller-only while before_agent_start appends worker rules", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-until": "Stop when onboarding is robust and tests are green",
  });

  createAutoModeExtension()(harness.pi as never);

  const sessionStart = harness.handlers.get("session_start");
  const beforeAgentStart = harness.handlers.get("before_agent_start");
  assert.ok(sessionStart);
  assert.ok(beforeAgentStart);

  await sessionStart?.({ reason: "startup" }, harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.text, "improve onboarding robustness");
  assert.doesNotMatch(harness.sentMessages[0]?.text ?? "", /completion gate/i);

  const latestState = getLatestAutoState(harness.entries);
  assert.match(String(latestState?.controllerSummary ?? ""), /Completion gate:\nStop when onboarding is robust and tests are green/);
  assert.equal(latestState?.assuranceMode, "pragmatic");

  const result = await beforeAgentStart?.({ systemPrompt: "BASE" });
  assert.equal(typeof result?.systemPrompt, "string");
  assert.match(result?.systemPrompt ?? "", /^BASE/);
  assert.match(result?.systemPrompt ?? "", /Auto-mode worker rules:/);
  assert.match(result?.systemPrompt ?? "", /Goal: improve onboarding robustness/);
  assert.doesNotMatch(result?.systemPrompt ?? "", /Completion gate:/);
});

test("session_start pauses fail-closed when auto-mode state cannot be persisted", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness(
    {
      "auto-goal": "improve onboarding robustness",
    },
    [],
    undefined,
    () => {
      throw new Error("disk full");
    },
  );

  createAutoModeExtension()(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  assert.equal(harness.sentMessages.length, 0);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("state persistence failed")));
  assert.ok(harness.statuses.some((entry) => entry.key === "auto-mode" && entry.value?.includes("paused")));
});

test("/auto off persistence failure leaves the run paused instead of silently disabled", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const initialState = {
    version: 2,
    enabled: true,
    paused: true,
    runId: "auto-persist-fail-off",
    goal: "improve onboarding robustness",
    mode: "iterations",
    maxIterations: 8,
    currentIteration: 2,
    startedAt: 1,
    commitPolicy: "final-or-milestone",
    pushPolicy: "final-or-milestone-if-upstream",
    assuranceMode: "pragmatic",
    controllerSummary: "restored",
    recentDecisions: [],
    consecutiveControllerFailures: 0,
    consecutiveWorkerFailures: 0,
    consecutiveStagnationCount: 0,
    consecutiveNoChangeCount: 0,
    resumePolicy: "restore-paused",
  };
  const harness = createHarness(
    {},
    [{ type: "custom", customType: AUTO_MODE_STATE_TYPE, data: initialState }],
    undefined,
    () => {
      throw new Error("disk full");
    },
  );

  createAutoModeExtension()(harness.pi as never);
  await harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);
  await harness.commands.get("auto")?.handler("off", harness.ctx);

  assert.ok(harness.notifications.some((entry) => entry.message.includes("state persistence failed")));
  assert.ok(harness.statuses.at(-1)?.value?.includes("paused"));
});

test("agent_end stops cleanly in pragmatic mode when the controller says the goal is met", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-clean-stop",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      repoFingerprint: "fingerprint-clean-stop",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Goal is complete",
      updatedSummary: "The onboarding robustness goal is complete.",
      goalStatus: "met",
      completionGateMet: true,
      finalMessage: "Done.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "The fix is complete.", stopReason: "stop" }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.enabled, false);
  assert.equal(harness.sentMessages.length, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Auto-mode stopped: Done.")));
});

test("agent_end appends exactly one snapshot per worker turn on the continue path", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "8",
  });
  let promptIndex = 0;
  const prompts = [
    "Inspect the next concrete gap.",
    "Apply the focused fix.",
    "Run the focused regression check.",
  ];

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: `head-turn-${promptIndex}`,
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: `fingerprint-turn-${promptIndex}`,
    }),
    decideControllerAction: async () => ({
      action: "continue",
      reason: "One concrete next step remains",
      updatedSummary: "The controller has one concrete next step.",
      goalStatus: "in_progress",
      completionGateMet: false,
      nextPrompt: prompts[promptIndex++] ?? `fallback-${promptIndex}`,
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  let previousSnapshotCount = countAutoStateEntries(harness.entries);
  for (let index = 0; index < 3; index += 1) {
    await agentEnd?.({
      messages: [{ role: "assistant", content: `worker turn ${index}`, stopReason: "stop" }],
    }, harness.ctx);

    const nextSnapshotCount = countAutoStateEntries(harness.entries);
    assert.equal(nextSnapshotCount - previousSnapshotCount, 1);
    previousSnapshotCount = nextSnapshotCount;
  }
});

test("session_start rejects strict mode without a verify command", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-assurance": "strict",
  });

  createAutoModeExtension()(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  assert.equal(harness.sentMessages.length, 0);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("--auto-assurance strict requires --auto-verify <cmd>")));
});

test("failed strict verification produces a short deterministic follow-up instead of an audit prompt", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-assurance": "strict",
    "auto-verify": "npm test",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-strict-verify",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      repoFingerprint: "fingerprint-strict-verify",
    }),
    runVerifyCommand: async () => ({
      command: "npm test",
      ok: false,
      exitCode: 1,
      stdout: "1 failing test",
      stderr: "",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "The goal appears complete",
      updatedSummary: "The main fix is implemented and looks ready.",
      goalStatus: "met",
      completionGateMet: true,
      finalMessage: "Done.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "The fix is complete.", stopReason: "stop" }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.currentIteration, 2);
  assert.match(harness.sentMessages.at(-1)?.text ?? "", /Run npm test until it passes/);
  assert.doesNotMatch(harness.sentMessages.at(-1)?.text ?? "", /git show/i);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Auto-mode finalization pass requested")));
});

test("default verify command runner uses a long-running timeout", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-verify": "npm test",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-verify-timeout",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      repoFingerprint: "fingerprint-verify-timeout",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Goal is complete",
      updatedSummary: "The goal is complete.",
      goalStatus: "met",
      completionGateMet: true,
      finalMessage: "Done.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "The fix is complete.", stopReason: "stop" }],
  }, harness.ctx);

  assert.deepEqual(harness.execCalls.at(-1), {
    command: "bash",
    args: ["-lc", "npm test"],
    options: { cwd: "/repo", timeout: 600_000 },
  });
});

test("controller model calls time out as inconclusive controller results", async () => {
  const { createAutoModeExtension } = await loadAutoModeModuleFromSource({
    piAiStubSource: "export async function complete() { return new Promise(() => {}); }\n",
    transformSource: (source) => source.replace("const CONTROLLER_DECISION_TIMEOUT_MS = 120_000;", "const CONTROLLER_DECISION_TIMEOUT_MS = 5;"),
  });
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-controller-timeout",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "fingerprint-controller-timeout",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "worker turn", stopReason: "stop" }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.consecutiveControllerFailures, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("controller was inconclusive")));
});

test("thrown controller decisions are counted like inconclusive controller results", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-throwing-controller",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "fingerprint-throwing-controller",
    }),
    decideControllerAction: async () => {
      throw new Error("provider unavailable");
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 1", stopReason: "stop" }],
  }, harness.ctx);
  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 2", stopReason: "stop" }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.paused, true);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("controller failed 2 times in a row")));
});

test("git snapshot errors pause auto-mode instead of bypassing finalization guards", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => {
      throw new Error("git timed out");
    },
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Goal is complete",
      updatedSummary: "The goal is complete.",
      goalStatus: "met",
      completionGateMet: true,
      finalMessage: "Done.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "The fix is complete.", stopReason: "stop" }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.paused, true);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("git state unavailable: git timed out")));
  assert.equal(harness.sentMessages.length, 1);
});

test("default git snapshot treats killed git commands as unavailable", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness(
    {
      "auto-goal": "improve onboarding robustness",
    },
    [],
    async (command, args) => {
      const gitCommand = args.join(" ");
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${gitCommand}`);

      if (gitCommand === "status --porcelain=v2 --branch --untracked-files=all -z") {
        return { code: 0, stdout: "", stderr: "", killed: true };
      }

      throw new Error(`Unexpected git command: ${gitCommand}`);
    },
  );

  createAutoModeExtension({
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Goal is complete",
      updatedSummary: "The goal is complete.",
      goalStatus: "met",
      completionGateMet: true,
      finalMessage: "Done.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "The fix is complete.", stopReason: "stop" }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.paused, true);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("git state unavailable: git status")));
  assert.equal(harness.sentMessages.length, 1);
});

test("stop guard refreshes git snapshot after verification mutates the working tree", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-verify": "npm test",
  });
  let gitSnapshotCalls = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => {
      gitSnapshotCalls += 1;
      if (gitSnapshotCalls === 1) {
        return {
          isGitRepo: true,
          head: "head-before-verify",
          status: "## main",
          changedFiles: [],
          dirty: false,
          hasUpstream: false,
          repoFingerprint: "fingerprint-before-verify",
        };
      }
      return {
        isGitRepo: true,
        head: "head-after-verify",
        status: "## main\n M coverage/summary.json",
        changedFiles: ["coverage/summary.json"],
        dirty: true,
        hasUpstream: false,
        repoFingerprint: "fingerprint-after-verify",
      };
    },
    runVerifyCommand: async () => ({
      command: "npm test",
      ok: true,
      exitCode: 0,
      stdout: "tests passed and coverage updated",
      stderr: "",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Goal is complete",
      updatedSummary: "The goal is complete and tests pass.",
      goalStatus: "met",
      completionGateMet: true,
      finalMessage: "Done.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "The fix is complete.", stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(gitSnapshotCalls, 2);
  assert.match(harness.sentMessages.at(-1)?.text ?? "", /Create the final atomic commit/);
  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.currentIteration, 2);
});

test("dirty git state triggers a short deterministic commit follow-up", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-dirty-stop",
      status: "## main\n M src/onboarding.ts",
      changedFiles: ["src/onboarding.ts"],
      dirty: true,
      hasUpstream: false,
      repoFingerprint: "fingerprint-dirty-stop",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Goal is complete",
      updatedSummary: "The fix is complete.",
      goalStatus: "met",
      completionGateMet: true,
      finalMessage: "Done.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "The fix is complete.", stopReason: "stop" }],
  }, harness.ctx);

  assert.match(harness.sentMessages.at(-1)?.text ?? "", /Create the final atomic commit/);
  assert.doesNotMatch(harness.sentMessages.at(-1)?.text ?? "", /git show/i);
});

test("agent_end pauses after repeated continue prompts instead of refining them with another controller", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const repeatedPrompt = "Add one focused regression test and rerun it.";
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "8",
  });
  let turn = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => {
      turn += 1;
      return {
        isGitRepo: true,
        head: `head-repeat-${turn}`,
        status: `## main\n M src/onboarding-${turn}.ts`,
        changedFiles: [`src/onboarding-${turn}.ts`],
        dirty: true,
        hasUpstream: false,
        repoFingerprint: `fingerprint-repeat-${turn}`,
      };
    },
    decideControllerAction: async () => ({
      action: "continue",
      reason: "One focused verification step remains",
      updatedSummary: "The next step is still the same focused verification pass.",
      goalStatus: "in_progress",
      completionGateMet: false,
      nextPrompt: repeatedPrompt,
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  for (let index = 0; index < 4; index += 1) {
    await agentEnd?.({
      messages: [{ role: "assistant", content: `worker turn ${index}`, stopReason: "stop" }],
    }, harness.ctx);
  }

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.paused, true);
  assert.equal(harness.sentMessages.filter((entry) => entry.text === repeatedPrompt).length, 3);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("controller produced the same next prompt repeatedly")));
});

test("agent_end pauses when repository state does not change across several iterations", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "8",
  });
  let promptIndex = 0;
  const prompts = [
    "Inspect the remaining validation gap.",
    "Add one focused regression test.",
    "Run the focused regression test.",
    "Summarize the focused regression result.",
  ];

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-no-change",
      status: "## main\n M src/onboarding.ts",
      changedFiles: ["src/onboarding.ts"],
      dirty: true,
      hasUpstream: false,
      repoFingerprint: "fingerprint-no-change",
    }),
    decideControllerAction: async () => ({
      action: "continue",
      reason: "A concrete next step remains",
      updatedSummary: "The controller keeps finding concrete local steps.",
      goalStatus: "in_progress",
      completionGateMet: false,
      nextPrompt: prompts[promptIndex++] ?? `fallback-${promptIndex}`,
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  for (let index = 0; index < 4; index += 1) {
    await agentEnd?.({
      messages: [{ role: "assistant", content: `worker turn ${index}`, stopReason: "stop" }],
    }, harness.ctx);
  }

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.paused, true);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("repository state has not changed across several iterations")));
});

test("default git snapshot fingerprints untracked file contents for no-change detection", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-mode-untracked-content-"));
  writeFileSync(join(tempDir, "draft.txt"), "draft-a");
  let untrackedHash = "hash-a";
  let promptIndex = 0;
  const harness = createHarness(
    {
      "auto-goal": "improve onboarding robustness",
      "auto-iterations": "8",
    },
    [],
    async (command, args) => {
      const gitCommand = args.join(" ");
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${gitCommand}`);

      if (gitCommand === "status --porcelain=v2 --branch --untracked-files=all -z") {
        return { code: 0, stdout: "# branch.oid head-untracked\0# branch.head main\0? draft.txt\0", stderr: "" };
      }
      if (gitCommand === "hash-object --no-filters -- draft.txt") {
        return { code: 0, stdout: `${untrackedHash}\n`, stderr: "" };
      }

      throw new Error(`Unexpected git command: ${gitCommand}`);
    },
  );
  harness.ctx.cwd = tempDir;

  createAutoModeExtension({
    decideControllerAction: async () => ({
      action: "continue",
      reason: "A concrete next step remains",
      updatedSummary: "The controller keeps finding concrete local steps.",
      goalStatus: "in_progress",
      completionGateMet: false,
      nextPrompt: `continue-${promptIndex++}`,
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 1", stopReason: "stop" }],
  }, harness.ctx);
  assert.equal(getLatestAutoState(harness.entries)?.consecutiveNoChangeCount, 0);

  untrackedHash = "hash-b";
  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 2", stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(getLatestAutoState(harness.entries)?.consecutiveNoChangeCount, 0);
  assert.equal(
    harness.execCalls.filter((call) => call.command === "git" && call.args[0] === "hash-object").length,
    2,
  );
});

test("default git snapshot preserves porcelain v2 rename source paths", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-mode-rename-status-"));
  writeFileSync(join(tempDir, "new-name.ts"), "renamed content");
  let capturedGitSnapshot: Record<string, unknown> | undefined;
  const harness = createHarness(
    {
      "auto-goal": "improve onboarding robustness",
    },
    [],
    async (command, args) => {
      const gitCommand = args.join(" ");
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${gitCommand}`);

      if (gitCommand === "status --porcelain=v2 --branch --untracked-files=all -z") {
        return {
          code: 0,
          stdout: "# branch.oid head-rename\0# branch.head main\0" + "2 R. N... 100644 100644 100644 oldhash newhash R100 new-name.ts\0old-name.ts\0",
          stderr: "",
        };
      }
      if (gitCommand === "hash-object --no-filters -- new-name.ts") {
        return { code: 0, stdout: "newhash\n", stderr: "" };
      }

      throw new Error(`Unexpected git command: ${gitCommand}`);
    },
  );
  harness.ctx.cwd = tempDir;

  createAutoModeExtension({
    decideControllerAction: async (_ctx: unknown, _snapshot: unknown, _worker: unknown, gitSnapshot: Record<string, unknown> | undefined) => {
      capturedGitSnapshot = gitSnapshot;
      return {
        action: "pause",
        reason: "reviewed rename status",
        updatedSummary: "Rename status reviewed.",
        goalStatus: "blocked",
        completionGateMet: false,
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "worker turn", stopReason: "stop" }],
  }, harness.ctx);

  assert.match(String(capturedGitSnapshot?.status ?? ""), /old-name\.ts -> new-name\.ts/);
  assert.deepEqual(capturedGitSnapshot?.changedFiles, ["new-name.ts"]);
});

test("default git snapshot includes unknown porcelain v2 records in dirty status", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  let capturedGitSnapshot: Record<string, unknown> | undefined;
  const harness = createHarness(
    {
      "auto-goal": "improve onboarding robustness",
    },
    [],
    async (command, args) => {
      const gitCommand = args.join(" ");
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${gitCommand}`);

      if (gitCommand === "status --porcelain=v2 --branch --untracked-files=all -z") {
        return { code: 0, stdout: "# branch.oid head-unknown\0# branch.head main\0x future status payload\0", stderr: "" };
      }

      throw new Error(`Unexpected git command: ${gitCommand}`);
    },
  );

  createAutoModeExtension({
    decideControllerAction: async (_ctx: unknown, _snapshot: unknown, _worker: unknown, gitSnapshot: Record<string, unknown> | undefined) => {
      capturedGitSnapshot = gitSnapshot;
      return {
        action: "pause",
        reason: "reviewed unknown status",
        updatedSummary: "Unknown status reviewed.",
        goalStatus: "blocked",
        completionGateMet: false,
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "worker turn", stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(capturedGitSnapshot?.dirty, true);
  assert.match(String(capturedGitSnapshot?.status ?? ""), /!! x future status payload/);
  assert.deepEqual(capturedGitSnapshot?.changedFiles, ["!! x future status payload"]);
});

test("stop guard refresh after verification uses lightweight git status without fingerprinting", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness(
    {
      "auto-goal": "improve onboarding robustness",
      "auto-verify": "npm test",
    },
    [],
    async (command, args) => {
      const gitCommand = args.join(" ");
      if (command === "bash") {
        assert.deepEqual(args, ["-lc", "npm test"]);
        return { code: 0, stdout: "tests passed", stderr: "" };
      }
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${gitCommand}`);

      if (gitCommand === "status --porcelain=v2 --branch --untracked-files=all -z") {
        const statusCallCount = harness.execCalls.filter((call) => call.command === "git" && call.args[0] === "status").length;
        if (statusCallCount === 1) {
          return { code: 0, stdout: "# branch.oid head-light-finalization\0# branch.head main\0", stderr: "" };
        }
        return {
          code: 0,
          stdout: "# branch.oid head-light-finalization\0# branch.head main\0" + "1 .M N... 100644 100644 100644 hash hash coverage/summary.json\0",
          stderr: "",
        };
      }
      if (gitCommand.startsWith("hash-object ")) {
        throw new Error("hash-object should not be called for lightweight finalization refresh");
      }

      throw new Error(`Unexpected git command: ${gitCommand}`);
    },
  );

  createAutoModeExtension({
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Goal is complete",
      updatedSummary: "The goal is complete and tests pass.",
      goalStatus: "met",
      completionGateMet: true,
      finalMessage: "Done.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "The fix is complete.", stopReason: "stop" }],
  }, harness.ctx);

  assert.match(harness.sentMessages.at(-1)?.text ?? "", /Create the final atomic commit/);
  assert.equal(harness.execCalls.filter((call) => call.command === "git" && call.args[0] === "hash-object").length, 0);
  assert.equal(harness.execCalls.filter((call) => call.command === "git" && call.args[0] === "status").length, 2);
});

test("default git snapshot uses metadata fallback for many untracked files", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-mode-untracked-many-"));
  const untrackedPaths = Array.from({ length: 101 }, (_, index) => `draft-${index}.txt`);
  for (const path of untrackedPaths) {
    writeFileSync(join(tempDir, path), "draft");
  }
  let promptIndex = 0;

  const harness = createHarness(
    {
      "auto-goal": "improve onboarding robustness",
      "auto-iterations": "8",
    },
    [],
    async (command, args) => {
      const gitCommand = args.join(" ");
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${gitCommand}`);

      if (gitCommand === "status --porcelain=v2 --branch --untracked-files=all -z") {
        return {
          code: 0,
          stdout: `# branch.oid head-many-untracked\0# branch.head main\0${untrackedPaths.map((path) => `? ${path}`).join("\0")}\0`,
          stderr: "",
        };
      }
      if (gitCommand.startsWith("hash-object ")) {
        throw new Error("hash-object should not be called for metadata-fallback untracked files");
      }

      throw new Error(`Unexpected git command: ${gitCommand}`);
    },
  );
  harness.ctx.cwd = tempDir;

  createAutoModeExtension({
    decideControllerAction: async () => ({
      action: "continue",
      reason: "A concrete next step remains",
      updatedSummary: "The controller keeps finding concrete local steps.",
      goalStatus: "in_progress",
      completionGateMet: false,
      nextPrompt: `continue-many-${promptIndex++}`,
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 1", stopReason: "stop" }],
  }, harness.ctx);
  assert.equal(getLatestAutoState(harness.entries)?.consecutiveNoChangeCount, 0);

  writeFileSync(join(tempDir, untrackedPaths[0]!), "draft with changed size");
  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 2", stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(getLatestAutoState(harness.entries)?.consecutiveNoChangeCount, 0);
  assert.equal(
    harness.execCalls.filter((call) => call.command === "git" && call.args[0] === "hash-object").length,
    0,
  );
});

test("default git snapshot uses path-only fallback for very large untracked sets", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-mode-untracked-path-only-"));
  const untrackedPaths = Array.from({ length: 2_001 }, (_, index) => `draft-${index}.txt`);
  for (const path of untrackedPaths) {
    writeFileSync(join(tempDir, path), "draft");
  }
  let promptIndex = 0;

  const harness = createHarness(
    {
      "auto-goal": "improve onboarding robustness",
      "auto-iterations": "8",
    },
    [],
    async (command, args) => {
      const gitCommand = args.join(" ");
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${gitCommand}`);

      if (gitCommand === "status --porcelain=v2 --branch --untracked-files=all -z") {
        return {
          code: 0,
          stdout: `# branch.oid head-path-only-untracked\0# branch.head main\0${untrackedPaths.map((path) => `? ${path}`).join("\0")}\0`,
          stderr: "",
        };
      }
      if (gitCommand.startsWith("hash-object ")) {
        throw new Error("hash-object should not be called for path-only untracked files");
      }

      throw new Error(`Unexpected git command: ${gitCommand}`);
    },
  );
  harness.ctx.cwd = tempDir;

  createAutoModeExtension({
    decideControllerAction: async () => ({
      action: "continue",
      reason: "A concrete next step remains",
      updatedSummary: "The controller keeps finding concrete local steps.",
      goalStatus: "in_progress",
      completionGateMet: false,
      nextPrompt: `continue-path-only-${promptIndex++}`,
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 1", stopReason: "stop" }],
  }, harness.ctx);
  assert.equal(getLatestAutoState(harness.entries)?.consecutiveNoChangeCount, 0);

  writeFileSync(join(tempDir, untrackedPaths[0]!), "draft with changed size");
  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 2", stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(getLatestAutoState(harness.entries)?.consecutiveNoChangeCount, 1);
  assert.equal(
    harness.execCalls.filter((call) => call.command === "git" && call.args[0] === "hash-object").length,
    0,
  );
});

test("agent_end persists below-threshold inconclusive controller state once", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-inconclusive-once",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "fingerprint-inconclusive-once",
    }),
    decideControllerAction: async () => undefined,
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const snapshotsAfterStart = countAutoStateEntries(harness.entries);

  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: "worker turn 1", stopReason: "stop" }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(countAutoStateEntries(harness.entries) - snapshotsAfterStart, 1);
  assert.equal(latestState?.paused, false);
  assert.equal(latestState?.consecutiveControllerFailures, 1);
  assert.equal(latestState?.lastSeenHead, "head-inconclusive-once");
  assert.equal(latestState?.lastSeenRepoFingerprint, "fingerprint-inconclusive-once");
  assert.ok(harness.notifications.some((entry) => entry.message.includes("controller was inconclusive")));
});

test("agent_end pauses after repeated inconclusive controller results", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-inconclusive",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "fingerprint-inconclusive",
    }),
    decideControllerAction: async () => undefined,
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 1", stopReason: "stop" }],
  }, harness.ctx);
  await agentEnd?.({
    messages: [{ role: "assistant", content: "worker turn 2", stopReason: "stop" }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.paused, true);
  assert.equal(harness.sentMessages.length, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("controller failed 2 times in a row")));
});

test("legacy V1 state restores paused with warnings under V2 semantics", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({}, [
    {
      type: "custom",
      customType: AUTO_MODE_STATE_TYPE,
      data: {
        version: 1,
        enabled: true,
        paused: false,
        runId: "auto-v1",
        goal: "improve onboarding robustness",
        mode: "iterations",
        maxIterations: 8,
        currentIteration: 3,
        startedAt: 1,
        commitPolicy: "final-or-milestone",
        pushPolicy: "final-or-milestone-if-upstream",
        completionPolicy: "continue-similar",
        controllerSummary: "legacy summary",
        recentDecisions: [],
        consecutiveControllerFailures: 0,
        consecutiveWorkerFailures: 0,
        consecutiveStagnationCount: 0,
        consecutiveNoChangeCount: 0,
        resumePolicy: "restore-running",
      },
    },
  ]);

  createAutoModeExtension()(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.version, 2);
  assert.equal(latestState?.paused, true);
  assert.equal(latestState?.migrationWarnings, undefined);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("legacy auto-mode V1 state")));
  assert.ok(harness.notifications.some((entry) => entry.message.includes("restored in paused mode")));
  assert.equal(harness.sentMessages.length, 0);
});

test("migration warnings are cleared after the first restore so a reload does not show them again", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({}, [
    {
      type: "custom",
      customType: AUTO_MODE_STATE_TYPE,
      data: {
        version: 1,
        enabled: true,
        paused: false,
        runId: "auto-v1",
        goal: "improve onboarding robustness",
        mode: "iterations",
        maxIterations: 8,
        currentIteration: 3,
        startedAt: 1,
        commitPolicy: "final-or-milestone",
        pushPolicy: "final-or-milestone-if-upstream",
        controllerSummary: "legacy summary",
        recentDecisions: [],
        consecutiveControllerFailures: 0,
        consecutiveWorkerFailures: 0,
        consecutiveStagnationCount: 0,
        consecutiveNoChangeCount: 0,
        resumePolicy: "restore-paused",
      },
    },
  ]);

  createAutoModeExtension()(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  const firstRestoreWarnings = harness.notifications.filter((entry) =>
    entry.message.includes("legacy auto-mode V1 state"),
  );
  assert.equal(firstRestoreWarnings.length, 1);

  harness.notifications.length = 0;
  await harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);

  const secondRestoreWarnings = harness.notifications.filter((entry) =>
    entry.message.includes("legacy auto-mode V1 state"),
  );
  assert.equal(secondRestoreWarnings.length, 0);
});

test("deprecated startup flags warn but do not prevent a pragmatic start", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-completion-policy": "continue-similar",
  });

  createAutoModeExtension()(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.assuranceMode, "pragmatic");
  assert.equal(harness.sentMessages[0]?.text, "improve onboarding robustness");
  assert.ok(harness.notifications.some((entry) => entry.message.includes("--auto-completion-policy is deprecated")));
});
