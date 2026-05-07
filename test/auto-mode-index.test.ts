import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import typescript from "typescript";
import { AUTO_MODE_STATE_TYPE } from "../extensions/auto-mode/core.ts";

let autoModeModulePromise: Promise<{ default: Function; createAutoModeExtension: Function }> | undefined;

async function loadAutoModeModule() {
  autoModeModulePromise ??= (async () => {
    const source = readFileSync(new URL("../extensions/auto-mode/index.ts", import.meta.url), "utf8");
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
    writeFileSync(piAiStubPath, 'export async function complete() { throw new Error("complete should not be called in auto-mode index tests"); }\n');

    const coreUrl = new URL("../extensions/auto-mode/core.ts", import.meta.url).href;
    const rewritten = transpiled
      .replace(/@mariozechner\/pi-ai/g, pathToFileURL(piAiStubPath).href)
      .replace(/\.\/core\.ts/g, coreUrl);

    const modulePath = join(tempDir, "index.mjs");
    writeFileSync(modulePath, rewritten);
    return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`) as Promise<{ default: Function; createAutoModeExtension: Function }>;
  })();

  return autoModeModulePromise;
}

function createHarness(
  initialFlags: Record<string, boolean | string | undefined> = {},
  initialEntries: unknown[] = [],
  execImpl?: (
    command: string,
    args: string[],
    options: Record<string, unknown> | undefined,
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
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

      if (gitCommand === "rev-parse --is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (gitCommand === "rev-parse HEAD") {
        return { code: 0, stdout: "head-untracked\n", stderr: "" };
      }
      if (gitCommand === "status --short --branch") {
        return { code: 0, stdout: "## main\n?? draft.txt\n", stderr: "" };
      }
      if (gitCommand === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
        return { code: 1, stdout: "", stderr: "no upstream" };
      }
      if (gitCommand === "diff --no-ext-diff --no-color HEAD --") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (gitCommand === "ls-files --others --exclude-standard -z") {
        return { code: 0, stdout: "draft.txt\0", stderr: "" };
      }
      if (gitCommand === "hash-object --no-filters -- draft.txt") {
        return { code: 0, stdout: `${untrackedHash}\n`, stderr: "" };
      }

      throw new Error(`Unexpected git command: ${gitCommand}`);
    },
  );

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
  assert.ok(harness.notifications.some((entry) => entry.message.includes("legacy auto-mode V1 state")));
  assert.ok(harness.notifications.some((entry) => entry.message.includes("restored in paused mode")));
  assert.equal(harness.sentMessages.length, 0);
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
