import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CodexRunnerError,
  createCodexRunner,
  type CodexRunOptions,
  type SpawnFn,
} from "../src/codexRunner.js";
import { defaultCodexCommand } from "../src/config.js";

const TEST_REQUEST_WORKSPACE = "C:/request-workspace";
const requestWorkspaceModule = vi.hoisted(() => ({
  createRequestWorkspace: vi.fn(async () => ({
    path: "C:/request-workspace",
    cleanup: async () => undefined,
  })),
}));

vi.mock("../src/requestWorkspace.js", () => requestWorkspaceModule);

const SAFE_DEFAULT_EXEC_ARGS = [
  "exec",
  "-",
  "--json",
  "--skip-git-repo-check",
  "--profile",
  "codexapi-runtime",
  "-C",
  TEST_REQUEST_WORKSPACE,
  "-c",
  'approval_policy="never"',
  "-c",
  "mcp_servers={}",
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--strict-config",
  "--enable",
  "browser_use",
  "--enable",
  "browser_use_external",
  "--enable",
  "code_mode",
  "--enable",
  "code_mode_host",
  "--enable",
  "in_app_browser",
  "--enable",
  "view_image",
  "--disable",
  "shell_tool",
  "--disable",
  "shell_snapshot",
  "--disable",
  "unified_exec",
  "-c",
  'web_search="live"',
  "-c",
  "tools.web_search=true",
];
const TEST_CODEX_HOME = "C:/codex-home";
const VALID_USAGE = {
  input_tokens: 21,
  cached_input_tokens: 8,
  output_tokens: 5,
  reasoning_output_tokens: 2,
};
const CODE_MODE_DISABLED_WARNING =
  "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";
const UNSTABLE_FEATURES_WARNING =
  "Under-development features enabled: code_mode. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in /var/lib/codexapi/home/config.toml.";
const UNSUPPORTED_CODE_MODE_WARNING =
  "Code Mode is enabled in configuration, but model `gpt-5.4-mini` does not advertise Code Mode support. This may degrade model performance. Disable `features.code_mode` and `features.code_mode_only`, or select a model whose metadata enables Code Mode.";

class FakeReadable extends EventEmitter {
  private readonly pendingChunks: string[] = [];

  push(chunk: string | null): void {
    if (chunk !== null) {
      if (this.listenerCount("data") === 0) {
        this.pendingChunks.push(chunk);
      } else {
        this.emit("data", chunk);
      }
    }
  }

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    super.on(eventName, listener);
    if (eventName === "data" && this.pendingChunks.length > 0) {
      queueMicrotask(() => {
        for (const chunk of this.pendingChunks.splice(0)) {
          this.emit("data", chunk);
        }
      });
    }
    return this;
  }
}

class FakeWritable extends EventEmitter {
  write = vi.fn();
  end = vi.fn();
}

class FakeChildProcess extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  kill = vi.fn();
  private pendingClose: number | null | undefined;
  private pendingError: Error | undefined;

  close(code: number | null): void {
    if (this.listenerCount("close") === 0) {
      this.pendingClose = code;
    } else {
      this.emit("close", code, null);
    }
  }

  exit(code: number | null): void {
    this.emit("exit", code, null);
  }

  fail(error: Error): void {
    if (this.listenerCount("error") === 0) {
      this.pendingError = error;
    } else {
      this.emit("error", error);
    }
  }

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    super.on(eventName, listener);
    if (eventName === "close" && this.pendingClose !== undefined) {
      const code = this.pendingClose;
      this.pendingClose = undefined;
      queueMicrotask(() => this.emit("close", code, null));
    }
    if (eventName === "error" && this.pendingError) {
      const error = this.pendingError;
      this.pendingError = undefined;
      queueMicrotask(() => this.emit("error", error));
    }
    return this;
  }
}

function createFakeSpawn(child: FakeChildProcess) {
  const spawn = vi.fn<SpawnFn>(() => child as never);
  return spawn;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function createRunnerRequestWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "codexapi-runner-workspace-"));
  const path = join(root, "request");
  await mkdir(path);
  const cleanup = vi.fn(async () => rm(path, { recursive: true, force: true }));
  return {
    path,
    cleanup,
    factory: vi.fn(async () => ({ path, cleanup })),
    removeRoot: () => rm(root, { recursive: true, force: true }),
  };
}

function jsonlCompletion(text: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: VALID_USAGE,
    }),
  ].join("\n");
}

function runJsonl(
  rawStdout: string,
  options: CodexRunOptions = {},
): ReturnType<NonNullable<ReturnType<typeof createCodexRunner>["runWithDetails"]>> {
  const child = new FakeChildProcess();
  const runner = createCodexRunner({
    command: "codex",
    workspace: "C:/workspace",
    codexHome: TEST_CODEX_HOME,
    timeoutMs: 1000,
    spawn: createFakeSpawn(child),
  });
  const result = runner.runWithDetails!("Hello", options);
  child.stdout.push(`${rawStdout}\n`);
  child.close(0);
  return result;
}

describe("Codex runner", () => {
  it("invokes codex exec with the expected arguments and workspace", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.run("Hello");
    child.stdout.push(`${jsonlCompletion("Hi")}\n`);
    child.close(0);

    await expect(resultPromise).resolves.toBe("Hi");
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      SAFE_DEFAULT_EXEC_ARGS,
      expect.objectContaining({
        cwd: TEST_REQUEST_WORKSPACE,
        shell: false,
        windowsHide: true,
      }),
    );
    expect(child.stdin.write).toHaveBeenCalledWith("Hello");
    expect(child.stdin.end).toHaveBeenCalled();
    const spawnedArgs = spawn.mock.calls[0]?.[1] ?? [];
    expect(spawnedArgs).not.toContain("danger-full-access");
    expect(spawnedArgs).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(spawnedArgs).toContain("--profile");
    expect(spawnedArgs).toContain("codexapi-runtime");
    expect(spawnedArgs).toContain("--enable");
    expect(spawnedArgs).toContain("code_mode_host");
    expect(spawnedArgs).toContain("--disable");
    expect(spawnedArgs).toContain("shell_tool");
    expect(spawnedArgs).not.toContain("--sandbox");
    expect(spawnedArgs).toContain('web_search="live"');
    expect(spawnedArgs).toContain("tools.web_search=true");
    expect(spawnedArgs).not.toContain("browser");
    expect(spawnedArgs).not.toContain("tool_discovery");
  });

  it("returns stdout and stderr from detailed runs", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });

    expect(runner.runWithDetails).toBeDefined();
    const rawStdout = jsonlCompletion("OK");
    const resultPromise = runner.runWithDetails!("Hello");
    child.stdout.push(`${rawStdout}\n`);
    child.stderr.push("skill loader warning\n");
    child.close(0);

    await expect(resultPromise).resolves.toEqual({
      stdout: "OK",
      rawStdout,
      stderr: "skill loader warning",
      usage: {
        inputTokens: 21,
        cachedInputTokens: 8,
        outputTokens: 5,
        reasoningOutputTokens: 2,
      },
      command: {
        executable: "codex",
        args: SAFE_DEFAULT_EXEC_ARGS,
        cwd: TEST_REQUEST_WORKSPACE,
        shell: false,
      },
    });
  });

  it("writes the prompt to stdin instead of passing it as a command argument", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });
    const largePrompt = "classify ".repeat(20_000);

    const resultPromise = runner.runWithDetails!(largePrompt);
    child.stdout.push(`${jsonlCompletion("OK")}\n`);
    child.close(0);

    await expect(resultPromise).resolves.toMatchObject({
      stdout: "OK",
      command: {
        args: SAFE_DEFAULT_EXEC_ARGS,
      },
    });
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      SAFE_DEFAULT_EXEC_ARGS,
      expect.objectContaining({
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(child.stdin.write).toHaveBeenCalledWith(largePrompt);
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("passes request model and reasoning effort to codex exec", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.runWithDetails!("Hello", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
    });
    child.stdout.push(`${jsonlCompletion("OK")}\n`);
    child.close(0);

    await expect(resultPromise).resolves.toMatchObject({ stdout: "OK" });
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      [
        ...SAFE_DEFAULT_EXEC_ARGS,
        "--model",
        "gpt-5.4-mini",
        "-c",
        "model_reasoning_effort=\"medium\"",
      ],
      expect.objectContaining({
        cwd: TEST_REQUEST_WORKSPACE,
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it("uses the pinned executable and a sanitized dedicated Codex environment", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const pinnedCommand = defaultCodexCommand();
    vi.stubEnv("OPENAI_API_KEY", "test-api-key");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "C:/certs/extra.pem");
    vi.stubEnv("PATH", "C:/attacker/bin");
    vi.stubEnv("APPDATA", "C:/attacker/appdata");
    vi.stubEnv("CODEX_PLUGIN_PATH", "C:/attacker/plugin");
    vi.stubEnv("MCP_SERVER_COMMAND", "attacker-mcp");
    vi.stubEnv("BROWSER", "attacker-browser");
    vi.stubEnv("SHELL", "attacker-shell");
    const runner = createCodexRunner({
      command: pinnedCommand.command,
      commandArgs: pinnedCommand.args,
      workspace: "C:/workspace",
      codexHome: "C:/dedicated-codex-home",
      timeoutMs: 1000,
      spawn,
    });

    try {
      const resultPromise = runner.run("Hello");
      child.stdout.push(`${jsonlCompletion("OK")}\n`);
      child.close(0);
      await expect(resultPromise).resolves.toBe("OK");

      expect(spawn.mock.calls[0]?.[0]).toBe(pinnedCommand.command);
      expect(spawn.mock.calls[0]?.[1].slice(0, pinnedCommand.args.length)).toEqual(
        pinnedCommand.args,
      );
      const childEnv = spawn.mock.calls[0]?.[2].env;
      expect(childEnv).toMatchObject({
        CODEX_HOME: "C:/dedicated-codex-home",
        HOME: "C:/dedicated-codex-home",
        USERPROFILE: "C:/dedicated-codex-home",
        OPENAI_API_KEY: "test-api-key",
        NODE_EXTRA_CA_CERTS: "C:/certs/extra.pem",
      });
      expect(childEnv).not.toHaveProperty("PATH");
      expect(childEnv).not.toHaveProperty("APPDATA");
      expect(childEnv).not.toHaveProperty("CODEX_PLUGIN_PATH");
      expect(childEnv).not.toHaveProperty("MCP_SERVER_COMMAND");
      expect(childEnv).not.toHaveProperty("BROWSER");
      expect(childEnv).not.toHaveProperty("SHELL");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("enables native web search without a request-level option", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.runWithDetails!("Hello");
    child.stdout.push(`${jsonlCompletion("OK")}\n`);
    child.close(0);

    await expect(resultPromise).resolves.toMatchObject({ stdout: "OK" });
    expect(spawn.mock.calls[0]?.[1]).toEqual(SAFE_DEFAULT_EXEC_ARGS);
  });

  it("attaches each locally created image path to the request", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });
    const imagePaths = [
      join(tmpdir(), "codexapi-first-cover.png"),
      join(tmpdir(), "codexapi-second-cover.webp"),
    ];

    const resultPromise = runner.runWithDetails!("Hello", { imagePaths });
    child.stdout.push(`${jsonlCompletion("OK")}\n`);
    child.close(0);

    await expect(resultPromise).resolves.toMatchObject({ stdout: "OK" });
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      ...SAFE_DEFAULT_EXEC_ARGS,
      "--image",
      imagePaths[0],
      "--image",
      imagePaths[1],
    ]);
  });

  it("parses the final message and token usage from Codex JSONL", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });
    const rawStdout = jsonlCompletion("Final answer");

    const resultPromise = runner.runWithDetails!("Hello");
    child.stdout.push(`${rawStdout}\n`);
    child.close(0);

    await expect(resultPromise).resolves.toMatchObject({
      stdout: "Final answer",
      rawStdout,
      usage: {
        inputTokens: 21,
        cachedInputTokens: 8,
        outputTokens: 5,
        reasoningOutputTokens: 2,
      },
    });
  });

  it("writes an output schema to a temporary file and removes it after execution", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const requestWorkspace = await createRunnerRequestWorkspace();
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
      requestWorkspaceFactory: requestWorkspace.factory,
    });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };

    try {
      const resultPromise = runner.runWithDetails!("Hello", { outputSchema: schema });
      await waitUntil(() => spawn.mock.calls.length === 1);
      const args = spawn.mock.calls[0]?.[1] ?? [];
      const schemaFlagIndex = args.indexOf("--output-schema");
      const schemaPath = args[schemaFlagIndex + 1];

      expect(schemaFlagIndex).toBeGreaterThan(-1);
      expect(schemaPath).toBe(join(requestWorkspace.path, ".codexapi-output-schema.json"));
      expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual(schema);

      child.stdout.push(`${jsonlCompletion('{"answer":"OK"}')}\n`);
      child.close(0);

      await expect(resultPromise).resolves.toMatchObject({ stdout: '{"answer":"OK"}' });
      expect(requestWorkspace.cleanup).toHaveBeenCalledOnce();
      await expect(access(requestWorkspace.path)).rejects.toThrow();
    } finally {
      await requestWorkspace.removeRoot();
    }
  });

  it("retries a transient request workspace cleanup failure after a successful run", async () => {
    const child = new FakeChildProcess();
    const requestWorkspace = await createRunnerRequestWorkspace();
    const cleanupFailure = new Error("transient cleanup failure");
    requestWorkspace.cleanup.mockRejectedValueOnce(cleanupFailure);
    const cleanupDelay = vi.fn(async () => undefined);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn: createFakeSpawn(child),
      requestWorkspaceFactory: requestWorkspace.factory,
      requestWorkspaceCleanupDelay: cleanupDelay,
    });

    try {
      const resultPromise = runner.run("Hello");
      child.stdout.push(`${jsonlCompletion("OK")}\n`);
      child.close(0);

      await expect(resultPromise).resolves.toBe("OK");
      expect(requestWorkspace.cleanup).toHaveBeenCalledTimes(2);
      expect(cleanupDelay).toHaveBeenCalledOnce();
      await expect(access(requestWorkspace.path)).rejects.toThrow();
    } finally {
      await requestWorkspace.removeRoot();
    }
  });

  it("stops normal request workspace cleanup after three failed attempts", async () => {
    const child = new FakeChildProcess();
    const requestWorkspace = await createRunnerRequestWorkspace();
    const sensitivePath = join(requestWorkspace.path, "secret.txt");
    const cleanupFailure = new Error(`cannot remove ${sensitivePath}`);
    requestWorkspace.cleanup.mockRejectedValue(cleanupFailure);
    const cleanupDelay = vi.fn(async () => undefined);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn: createFakeSpawn(child),
      requestWorkspaceFactory: requestWorkspace.factory,
      requestWorkspaceCleanupDelay: cleanupDelay,
    });

    try {
      const resultPromise = runner.run("Hello");
      child.stdout.push(`${jsonlCompletion("OK")}\n`);
      child.close(0);

      await expect(resultPromise).rejects.toBe(cleanupFailure);
      expect(requestWorkspace.cleanup).toHaveBeenCalledTimes(3);
      expect(cleanupDelay).toHaveBeenCalledTimes(2);
      await expect(access(requestWorkspace.path)).resolves.toBeUndefined();
    } finally {
      await requestWorkspace.removeRoot();
    }
  });

  it.each([
    ["nonzero exit", "NON_ZERO_EXIT", (child: FakeChildProcess) => child.close(1)],
    ["spawn failure", "SPAWN_ERROR", (child: FakeChildProcess) => child.fail(new Error("ENOENT"))],
    [
      "structured-output failure",
      "INVALID_OUTPUT",
      (child: FakeChildProcess) => {
        child.stdout.push("not json\n");
        child.close(0);
      },
    ],
  ])("removes the request workspace after a %s", async (_name, code, finish) => {
    const child = new FakeChildProcess();
    const requestWorkspace = await createRunnerRequestWorkspace();
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn: createFakeSpawn(child),
      requestWorkspaceFactory: requestWorkspace.factory,
    });

    try {
      const resultPromise = runner.run("Hello");
      await waitUntil(() => requestWorkspace.factory.mock.calls.length === 1);
      finish(child);

      await expect(resultPromise).rejects.toMatchObject({ code });
      expect(requestWorkspace.cleanup).toHaveBeenCalledOnce();
      await expect(access(requestWorkspace.path)).rejects.toThrow();
    } finally {
      await requestWorkspace.removeRoot();
    }
  });

  it("removes the request workspace after a timeout once the child closes", async () => {
    const child = new FakeChildProcess();
    const requestWorkspace = await createRunnerRequestWorkspace();
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 5,
      spawn: createFakeSpawn(child),
      requestWorkspaceFactory: requestWorkspace.factory,
    });

    try {
      const resultPromise = runner.run("Hello");
      await waitUntil(() => child.kill.mock.calls.length === 1);
      child.close(null);

      await expect(resultPromise).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(requestWorkspace.cleanup).toHaveBeenCalledOnce();
      await expect(access(requestWorkspace.path)).rejects.toThrow();
    } finally {
      await requestWorkspace.removeRoot();
    }
  });

  it("removes the request workspace after cancellation once the child closes", async () => {
    const controller = new AbortController();
    const child = new FakeChildProcess();
    const requestWorkspace = await createRunnerRequestWorkspace();
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn: createFakeSpawn(child),
      requestWorkspaceFactory: requestWorkspace.factory,
    });

    try {
      const resultPromise = runner.runWithDetails!("Hello", { signal: controller.signal });
      await waitUntil(() => requestWorkspace.factory.mock.calls.length === 1);
      controller.abort();
      child.close(null);

      await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
      expect(requestWorkspace.cleanup).toHaveBeenCalledOnce();
      await expect(access(requestWorkspace.path)).rejects.toThrow();
    } finally {
      await requestWorkspace.removeRoot();
    }
  });

  it("rejects with a typed error when codex exits non-zero", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: ["C:/codex/codex.js"],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.run("Hello");
    child.stderr.push("Something failed\n");
    child.close(2);

    await expect(resultPromise).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "NON_ZERO_EXIT",
      exitCode: 2,
      stderr: "Something failed",
      command: {
        executable: "codex",
        args: ["C:/codex/codex.js", ...SAFE_DEFAULT_EXEC_ARGS],
        cwd: TEST_REQUEST_WORKSPACE,
        shell: false,
      },
    });
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      ["C:/codex/codex.js", ...SAFE_DEFAULT_EXEC_ARGS],
      expect.any(Object),
    );
  });

  it("rejects with a typed error when the command cannot be started", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "missing-codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.run("Hello");
    child.fail(Object.assign(new Error("spawn missing-codex ENOENT"), { code: "ENOENT" }));

    await expect(resultPromise).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "SPAWN_ERROR",
    });
  });

  it("rejects command execution even when a later agent message completes", async () => {
      const child = new FakeChildProcess();
      const spawn = createFakeSpawn(child);
      const runner = createCodexRunner({
        command: "codex",
        workspace: "C:/workspace",
        codexHome: TEST_CODEX_HOME,
        timeoutMs: 1000,
        spawn,
      });
      const rawStdout = [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item-forbidden", type: "command_execution", command: "whoami" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item-message", type: "agent_message", text: "concealed" },
        }),
        JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
      ].join("\n");

      const resultPromise = runner.runWithDetails!("Hello");
      child.stdout.push(`${rawStdout}\n`);
      child.close(0);

      await expect(resultPromise).rejects.toMatchObject({
        name: "CodexRunnerError",
        code: "INVALID_OUTPUT",
        message: "Codex JSONL output contained a forbidden command execution item.",
      });
    });

  it("returns only terminal text and usage after completion-only research items", async () => {
    const rawStdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-image", type: "image_view", path: "/safe/image.png" },
      }),
      JSON.stringify({
        type: "item.started",
        item: { id: "item-browser", type: "web_search", query: "Coffee Rush BGG" },
      }),
      JSON.stringify({
        type: "item.updated",
        item: { id: "item-browser", type: "web_search", query: "Coffee Rush BGG" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-browser", type: "web_search", query: "Coffee Rush BGG" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-metadata", type: "research_summary", citations: [] },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-message", type: "agent_message", text: "research answer" },
      }),
      JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
    ].join("\n");

    await expect(runJsonl(rawStdout)).resolves.toMatchObject({
      stdout: "research answer",
      usage: {
        inputTokens: 21,
        cachedInputTokens: 8,
        outputTokens: 5,
        reasoningOutputTokens: 2,
      },
    });
  });

  it("accepts the exact pinned pre-turn code-mode-disabled diagnostic without returning it", async () => {
    const rawStdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-warning", type: "error", message: CODE_MODE_DISABLED_WARNING },
      }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-message", type: "agent_message", text: "safe answer" },
      }),
      JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
    ].join("\n");

    await expect(runJsonl(rawStdout)).resolves.toMatchObject({ stdout: "safe answer" });
  });

  it("accepts the pinned 0.147 informational pre-turn warning sequence without returning it", async () => {
    const rawStdout = completionWithPreTurnWarnings([
      preTurnWarning("item-warning-1", UNSTABLE_FEATURES_WARNING),
      preTurnWarning("item-warning-2", UNSUPPORTED_CODE_MODE_WARNING),
    ]);

    await expect(
      runJsonl(rawStdout, { model: "gpt-5.4-mini" }),
    ).resolves.toMatchObject({ stdout: "safe answer" });
  });

  it("accepts the exact unsupported-model warning when unstable warnings are suppressed", async () => {
    const rawStdout = completionWithPreTurnWarnings([
      preTurnWarning("item-warning", UNSUPPORTED_CODE_MODE_WARNING),
    ]);

    await expect(
      runJsonl(rawStdout, { model: "gpt-5.4-mini" }),
    ).resolves.toMatchObject({ stdout: "safe answer" });
  });

  it.each([
    ["unknown warning text", [preTurnWarning("item-warning", "other")]],
    [
      "reordered pinned warnings",
      [
        preTurnWarning("item-warning-1", UNSUPPORTED_CODE_MODE_WARNING),
        preTurnWarning("item-warning-2", UNSTABLE_FEATURES_WARNING),
      ],
    ],
    [
      "duplicate pinned warnings",
      [
        preTurnWarning("item-warning-1", UNSUPPORTED_CODE_MODE_WARNING),
        preTurnWarning("item-warning-2", UNSUPPORTED_CODE_MODE_WARNING),
      ],
    ],
    [
      "warning for a different model",
      [
        preTurnWarning(
          "item-warning",
          UNSUPPORTED_CODE_MODE_WARNING.replace("gpt-5.4-mini", "gpt-5.5"),
        ),
      ],
    ],
    [
      "malformed warning item",
      [{ type: "item.completed", item: { id: "", type: "error", message: UNSUPPORTED_CODE_MODE_WARNING } }],
    ],
  ])("rejects %s before turn start", async (_name, warningEvents) => {
    await expect(
      runJsonl(
        completionWithPreTurnWarnings(warningEvents),
        { model: "gpt-5.4-mini" },
      ),
    ).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "INVALID_OUTPUT",
    });
  });

  it("rejects a pinned informational warning after turn start", async () => {
    const rawStdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify(preTurnWarning("item-warning", UNSUPPORTED_CODE_MODE_WARNING)),
      JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
    ].join("\n");

    await expect(
      runJsonl(rawStdout, { model: "gpt-5.4-mini" }),
    ).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "INVALID_OUTPUT",
    });
  });

  it.each([
    [
      "a different pre-turn error",
      [
        {
          type: "item.completed",
          item: { id: "item-warning", type: "error", message: "other" },
        },
      ],
    ],
    [
      "a duplicate pinned pre-turn diagnostic",
      [
        {
          type: "item.completed",
          item: { id: "item-warning-1", type: "error", message: CODE_MODE_DISABLED_WARNING },
        },
        {
          type: "item.completed",
          item: { id: "item-warning-2", type: "error", message: CODE_MODE_DISABLED_WARNING },
        },
      ],
    ],
  ])("rejects %s", async (_name, warningEvents) => {
    const rawStdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      ...warningEvents.map((event) => JSON.stringify(event)),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-message", type: "agent_message", text: "concealed" },
      }),
      JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
    ].join("\n");

    await expect(runJsonl(rawStdout)).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "INVALID_OUTPUT",
    });
  });

  it.each([
    ["missing item id", { id: "", type: "agent_message", text: "answer" }],
    ["arbitrary error item", { id: "item-1", type: "error", message: "other" }],
  ])("rejects %s", async (_name, item) => {
    const rawStdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item }),
      JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
    ].join("\n");

    await expect(runJsonl(rawStdout)).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "INVALID_OUTPUT",
    });
  });

  it.each([
    [
      "web-search update before start",
      [
        { type: "item.updated", item: { id: "item-search", type: "web_search" } },
      ],
    ],
    [
      "duplicate web-search start",
      [
        { type: "item.started", item: { id: "item-search", type: "web_search" } },
        { type: "item.started", item: { id: "item-search", type: "web_search" } },
      ],
    ],
    [
      "duplicate web-search completion",
      [
        { type: "item.started", item: { id: "item-search", type: "web_search" } },
        { type: "item.completed", item: { id: "item-search", type: "web_search" } },
        { type: "item.completed", item: { id: "item-search", type: "web_search" } },
      ],
    ],
    [
      "web-search update after completion",
      [
        { type: "item.started", item: { id: "item-search", type: "web_search" } },
        { type: "item.completed", item: { id: "item-search", type: "web_search" } },
        { type: "item.updated", item: { id: "item-search", type: "web_search" } },
      ],
    ],
    [
      "item type change",
      [
        { type: "item.started", item: { id: "item-search", type: "web_search" } },
        { type: "item.updated", item: { id: "item-search", type: "reasoning", text: "x" } },
      ],
    ],
    [
      "unfinished web search at turn completion",
      [
        { type: "item.started", item: { id: "item-search", type: "web_search" } },
      ],
    ],
    [
      "started reasoning item incompatible with 0.147 completion-only shape",
      [
        { type: "item.started", item: { id: "item-reasoning", type: "reasoning", text: "x" } },
      ],
    ],
    [
      "duplicate completion-only item id",
      [
        { type: "item.completed", item: { id: "item-reasoning", type: "reasoning", text: "x" } },
        { type: "item.completed", item: { id: "item-reasoning", type: "reasoning", text: "x" } },
      ],
    ],
  ])("rejects %s", async (_name, itemEvents) => {
    const rawStdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      ...itemEvents.map((event) => JSON.stringify(event)),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-message", type: "agent_message", text: "concealed" },
      }),
      JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
    ].join("\n");

    await expect(runJsonl(rawStdout)).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "INVALID_OUTPUT",
    });
  });

  it("accepts completion-only reasoning with a unique nonempty ID", async () => {
    const rawStdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-reasoning", type: "reasoning", text: "summary" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-message", type: "agent_message", text: "answer" },
      }),
      JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
    ].join("\n");

    await expect(runJsonl(rawStdout)).resolves.toMatchObject({ stdout: "answer" });
  });

  it.each([
    ["missing", { ...VALID_USAGE, input_tokens: undefined }],
    ["non-number", { ...VALID_USAGE, input_tokens: "21" }],
    ["non-integer", { ...VALID_USAGE, input_tokens: 1.5 }],
    ["negative", { ...VALID_USAGE, input_tokens: -1 }],
    ["unsafe integer", { ...VALID_USAGE, input_tokens: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s token usage", async (_name, usage) => {
    const rawStdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-message", type: "agent_message", text: "answer" },
      }),
      JSON.stringify({ type: "turn.completed", usage }),
    ].join("\n");

    await expect(runJsonl(rawStdout)).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "INVALID_OUTPUT",
    });
  });

  it.each(["error", "turn.failed"])(
    "rejects a top-level %s event even when a later agent message completes",
    async (eventType) => {
      const child = new FakeChildProcess();
      const spawn = createFakeSpawn(child);
      const runner = createCodexRunner({
        command: "codex",
        workspace: "C:/workspace",
        codexHome: TEST_CODEX_HOME,
        timeoutMs: 1000,
        spawn,
      });
      const rawStdout = [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: eventType, message: "failed" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item-message", type: "agent_message", text: "concealed" },
        }),
        JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
      ].join("\n");

      const resultPromise = runner.runWithDetails!("Hello");
      child.stdout.push(`${rawStdout}\n`);
      child.close(0);

      await expect(resultPromise).rejects.toMatchObject({
        name: "CodexRunnerError",
        code: "INVALID_OUTPUT",
      });
    },
  );

  it("rejects any event after the terminal turn completion", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });
    const rawStdout = [
      jsonlCompletion("early answer"),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-forbidden", type: "command_execution" },
      }),
    ].join("\n");

    const resultPromise = runner.runWithDetails!("Hello");
    child.stdout.push(`${rawStdout}\n`);
    child.close(0);

    await expect(resultPromise).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "INVALID_OUTPUT",
    });
  });

  it("rejects successful non-JSONL output instead of returning raw stdout", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.runWithDetails!("Hello");
    child.stdout.push("unverified raw output\n");
    child.close(0);

    await expect(resultPromise).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "INVALID_OUTPUT",
    });
  });

  it.each(["stdout", "stderr"])(
    "rejects a successful run when bounded %s output overflowed",
    async (streamName) => {
      const child = new FakeChildProcess();
      const spawn = createFakeSpawn(child);
      const rawStdout = jsonlCompletion("early valid answer");
      const runner = createCodexRunner({
        command: "codex",
        workspace: "C:/workspace",
        codexHome: TEST_CODEX_HOME,
        timeoutMs: 1000,
        maxOutputBytes: Buffer.byteLength(rawStdout, "utf8"),
        spawn,
      });

      const resultPromise = runner.runWithDetails!("Hello");
      child.stdout.push(rawStdout);
      if (streamName === "stdout") {
        child.stdout.push("\u{1f510}");
      } else {
        child.stderr.push(
          "\u{1f510}".repeat(Buffer.byteLength(rawStdout, "utf8")),
        );
      }
      child.close(0);

      await expect(resultPromise).rejects.toMatchObject({
        name: "CodexRunnerError",
        code: "INVALID_OUTPUT",
      });
    },
  );

  it("rejects an already-cancelled run without spawning Codex", async () => {
    const controller = new AbortController();
    controller.abort();
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.runWithDetails!("sensitive prompt", {
      signal: controller.signal,
    });
    if (spawn.mock.calls.length > 0) {
      child.stdout.push("unexpected success\n");
      child.close(0);
    }

    await expect(resultPromise).rejects.toMatchObject({
      name: "CodexRunnerError",
      code: "CANCELLED",
      message: "Codex command was cancelled.",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills once on mid-run cancellation and rejects only after the child closes", async () => {
    const controller = new AbortController();
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
    });
    let settled = false;

    const resultPromise = runner.runWithDetails!("sensitive prompt", {
      signal: controller.signal,
    });
    await waitUntil(() => spawn.mock.calls.length === 1);
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "CANCELLED",
      stdout: "partial output",
      stderr: "partial warning",
    });
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    child.stdout.push("partial output\n");
    child.stderr.push("partial warning\n");

    controller.abort();
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    child.close(null);
    await rejection;
    child.close(0);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("force-kills after graceful termination is ignored and waits for verified close", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      terminationGraceMs: 50,
      forceTerminationGraceMs: 50,
      spawn,
    });
    let settled = false;

    const resultPromise = runner.runWithDetails!("sensitive prompt", {
      signal: controller.signal,
    });
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const expectation = expect(resultPromise).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Codex command was cancelled.",
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledOnce();
      controller.abort();
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      await vi.advanceTimersByTimeAsync(49);
      await expect(Promise.race([
        resultPromise.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("pending"),
      ])).resolves.toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(settled).toBe(false);

      child.exit(null);
      await Promise.resolve();
      expect(settled).toBe(false);

      child.close(null);
      await expectation;
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(child.eventNames()).toEqual([]);
      expect(child.stdout.eventNames()).toEqual([]);
      expect(child.stderr.eventNames()).toEqual([]);
    } finally {
      await vi.runAllTimersAsync();
      await resultPromise.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("returns a fatal error and retains the schema when force termination is unverified", async () => {
    const controller = new AbortController();
    const child = new FakeChildProcess();
    child.kill.mockReturnValue(false);
    const spawn = createFakeSpawn(child);
    const requestWorkspace = await createRunnerRequestWorkspace();
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      terminationGraceMs: 5,
      forceTerminationGraceMs: 5,
      spawn,
      requestWorkspaceFactory: requestWorkspace.factory,
    });

    const resultPromise = runner.runWithDetails!("sensitive prompt", {
      signal: controller.signal,
      outputSchema: { type: "object" },
    });
    await waitUntil(() => spawn.mock.calls.length === 1);
    const args = spawn.mock.calls[0]?.[1] ?? [];
    const schemaPath = args[args.indexOf("--output-schema") + 1]!;
    let fatalError: CodexRunnerError | undefined;
    const capturedResult = resultPromise.catch((error: unknown) => {
      fatalError = error as CodexRunnerError;
    });

    try {
      controller.abort();
      await capturedResult;
      expect(fatalError).toMatchObject({
        code: "TERMINATION_FAILED",
        childMayBeRunning: true,
        message: "Codex process could not be terminated.",
      });
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      await expect(access(schemaPath)).resolves.toBeUndefined();
      await expect(access(requestWorkspace.path)).resolves.toBeUndefined();
      expect(child.listenerCount("close")).toBe(1);
      expect(child.listenerCount("error")).toBe(1);

      child.exit(null);
      await expect(access(schemaPath)).resolves.toBeUndefined();

      const cleanupWhenSafe = fatalError?.cleanupWhenSafe;
      expect(cleanupWhenSafe).toBeInstanceOf(Promise);
      child.close(null);
      await cleanupWhenSafe!;
      await vi.waitFor(async () => {
        await expect(access(schemaPath)).rejects.toThrow();
      });
      await expect(access(requestWorkspace.path)).rejects.toThrow();
      expect(requestWorkspace.cleanup).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(child.eventNames()).toEqual([]);
      expect(child.stdout.eventNames()).toEqual([]);
      expect(child.stderr.eventNames()).toEqual([]);
    } finally {
      await capturedResult;
      await requestWorkspace.removeRoot();
    }
  });

  it("retries deferred cleanup without starting a duplicate removal", async () => {
    const controller = new AbortController();
    const child = new FakeChildProcess();
    child.kill.mockReturnValue(false);
    const spawn = createFakeSpawn(child);
    const requestWorkspace = await createRunnerRequestWorkspace();
    let rejectFirstCleanup!: (error: Error) => void;
    requestWorkspace.cleanup.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => {
        rejectFirstCleanup = reject;
      }),
    );
    const cleanupDelay = vi.fn(async () => undefined);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      terminationGraceMs: 5,
      forceTerminationGraceMs: 5,
      spawn,
      requestWorkspaceFactory: requestWorkspace.factory,
      requestWorkspaceCleanupDelay: cleanupDelay,
    });

    try {
      const resultPromise = runner.runWithDetails!("Hello", { signal: controller.signal });
      await waitUntil(() => spawn.mock.calls.length === 1);
      controller.abort();
      const error = await resultPromise.then(
        () => {
          throw new Error("Expected unverified termination to fail.");
        },
        (cause: unknown) => cause,
      );
      if (!(error instanceof CodexRunnerError)) {
        throw error;
      }
      expect(error).toMatchObject({ code: "TERMINATION_FAILED" });

      child.close(null);
      await error.cleanupWhenSafe;
      await waitUntil(() => requestWorkspace.cleanup.mock.calls.length === 1);
      expect(requestWorkspace.cleanup).toHaveBeenCalledOnce();

      rejectFirstCleanup(new Error("transient workspace removal failure"));
      await waitUntil(() => requestWorkspace.cleanup.mock.calls.length === 2);
      await vi.waitFor(async () => {
        await expect(access(requestWorkspace.path)).rejects.toThrow();
      });
      expect(cleanupDelay).toHaveBeenCalledOnce();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      await requestWorkspace.removeRoot();
    }
  });

  it("bounds permanent deferred cleanup failure and emits a path-free warning", async () => {
    const controller = new AbortController();
    const child = new FakeChildProcess();
    child.kill.mockReturnValue(false);
    const spawn = createFakeSpawn(child);
    const requestWorkspace = await createRunnerRequestWorkspace();
    const sensitivePath = join(requestWorkspace.path, "private-prompt.txt");
    requestWorkspace.cleanup.mockRejectedValue(
      new Error(`cannot remove ${sensitivePath}`),
    );
    const cleanupDelay = vi.fn(async () => undefined);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      terminationGraceMs: 5,
      forceTerminationGraceMs: 5,
      spawn,
      requestWorkspaceFactory: requestWorkspace.factory,
      requestWorkspaceCleanupDelay: cleanupDelay,
    });

    try {
      const resultPromise = runner.runWithDetails!("Hello", { signal: controller.signal });
      await waitUntil(() => spawn.mock.calls.length === 1);
      controller.abort();
      const error = await resultPromise.then(
        () => {
          throw new Error("Expected unverified termination to fail.");
        },
        (cause: unknown) => cause,
      );
      if (!(error instanceof CodexRunnerError)) {
        throw error;
      }

      child.close(null);
      await error.cleanupWhenSafe;
      await waitUntil(() => warning.mock.calls.length === 1);
      expect(requestWorkspace.cleanup).toHaveBeenCalledTimes(3);
      expect(cleanupDelay).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith(
        "Codex request workspace cleanup failed after bounded retries.",
        { code: "CODEXAPI_REQUEST_WORKSPACE_CLEANUP_FAILED" },
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain(sensitivePath);
    } finally {
      warning.mockRestore();
      await requestWorkspace.removeRoot();
    }
  });

  it("does not leave a grace timer when kill closes the child synchronously", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const child = new FakeChildProcess();
    child.kill.mockImplementation(() => {
      child.close(null);
      return true;
    });
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      terminationGraceMs: 50,
      forceTerminationGraceMs: 50,
      spawn,
    });

    const resultPromise = runner.runWithDetails!("sensitive prompt", {
      signal: controller.signal,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledOnce();
      controller.abort();
      await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await resultPromise.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("removes an output-schema directory after a cancelled child closes", async () => {
    const controller = new AbortController();
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const requestWorkspace = await createRunnerRequestWorkspace();
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 1000,
      spawn,
      requestWorkspaceFactory: requestWorkspace.factory,
    });

    const resultPromise = runner.runWithDetails!("sensitive prompt", {
      signal: controller.signal,
      outputSchema: { type: "object" },
    });
    await waitUntil(() => spawn.mock.calls.length === 1);
    const args = spawn.mock.calls[0]?.[1] ?? [];
    const schemaPath = args[args.indexOf("--output-schema") + 1]!;
    await expect(access(schemaPath)).resolves.toBeUndefined();

    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(access(schemaPath)).resolves.toBeUndefined();
    child.close(null);

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(access(schemaPath)).rejects.toThrow();
    expect(requestWorkspace.cleanup).toHaveBeenCalledOnce();
    await requestWorkspace.removeRoot();
  });

  it("kills the child on timeout and rejects with TIMEOUT only after it closes", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      codexHome: TEST_CODEX_HOME,
      timeoutMs: 50,
      spawn,
    });

    const resultPromise = runner.run("Hello");
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const expectation = expect(resultPromise).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    try {
      await vi.advanceTimersByTimeAsync(51);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      child.close(null);

      await expectation;
      await resultPromise.catch((error) => {
        expect(error).toBeInstanceOf(CodexRunnerError);
      });
    } finally {
      child.close(null);
      await expectation;
      vi.useRealTimers();
    }
  });
});

function preTurnWarning(id: string, message: string) {
  return { type: "item.completed", item: { id, type: "error", message } };
}

function completionWithPreTurnWarnings(warningEvents: readonly unknown[]): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    ...warningEvents.map((event) => JSON.stringify(event)),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item-message", type: "agent_message", text: "safe answer" },
    }),
    JSON.stringify({ type: "turn.completed", usage: VALID_USAGE }),
  ].join("\n");
}
