import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CodexRunnerError,
  createCodexRunner,
  type SpawnFn,
} from "../src/codexRunner.js";

const SAFE_DEFAULT_EXEC_ARGS = [
  "exec",
  "-",
  "--json",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "-c",
  'approval_policy="never"',
  "-c",
  "mcp_servers={}",
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--strict-config",
  "--disable",
  "shell_tool",
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "--disable",
  "shell_snapshot",
  "--disable",
  "browser_use",
  "--disable",
  "browser_use_external",
  "--disable",
  "browser_use_full_cdp_access",
  "--disable",
  "in_app_browser",
  "--disable",
  "computer_use",
  "--disable",
  "code_mode",
  "--disable",
  "image_generation",
  "--disable",
  "multi_agent",
  "--disable",
  "memories",
  "--disable",
  "hooks",
  "--disable",
  "tool_suggest",
  "--disable",
  "enable_mcp_apps",
  "--disable",
  "skill_mcp_dependency_install",
  "--disable",
  "tool_call_mcp_elicitation",
  "--disable",
  "code_mode_host",
  "--disable",
  "remote_plugin",
  "--disable",
  "plugin_sharing",
  "--disable",
  "enable_fanout",
  "--disable",
  "workspace_dependencies",
  "-c",
  'web_search="disabled"',
];

class FakeReadable extends EventEmitter {
  push(chunk: string | null): void {
    if (chunk !== null) {
      this.emit("data", chunk);
    }
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

  close(code: number | null): void {
    this.emit("close", code, null);
  }

  fail(error: Error): void {
    this.emit("error", error);
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

function jsonlCompletion(text: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 21,
        cached_input_tokens: 8,
        output_tokens: 5,
        reasoning_output_tokens: 2,
      },
    }),
  ].join("\n");
}

describe("Codex runner", () => {
  it("invokes codex exec with the expected arguments and workspace", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.run("Hello");
    child.stdout.push("Hi\n");
    child.close(0);

    await expect(resultPromise).resolves.toBe("Hi");
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      SAFE_DEFAULT_EXEC_ARGS,
      expect.objectContaining({
        cwd: "C:/workspace",
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
    expect(spawnedArgs).not.toContain("--profile");
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
      timeoutMs: 1000,
      spawn,
    });

    expect(runner.runWithDetails).toBeDefined();
    const resultPromise = runner.runWithDetails!("Hello");
    child.stdout.push("OK\n");
    child.stderr.push("skill loader warning\n");
    child.close(0);

    await expect(resultPromise).resolves.toEqual({
      stdout: "OK",
      rawStdout: "OK",
      stderr: "skill loader warning",
      command: {
        executable: "codex",
        args: SAFE_DEFAULT_EXEC_ARGS,
        cwd: "C:/workspace",
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
      timeoutMs: 1000,
      spawn,
    });
    const largePrompt = "classify ".repeat(20_000);

    const resultPromise = runner.runWithDetails!(largePrompt);
    child.stdout.push("OK\n");
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
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.runWithDetails!("Hello", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
    });
    child.stdout.push("OK\n");
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
        cwd: "C:/workspace",
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it("disables web search when the request does not opt in", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.runWithDetails!("Hello", { webSearch: false });
    child.stdout.push("OK\n");
    child.close(0);

    await expect(resultPromise).resolves.toMatchObject({ stdout: "OK" });
    expect(spawn.mock.calls[0]?.[1]).toEqual(SAFE_DEFAULT_EXEC_ARGS);
  });

  it("enables only native web search when the request opts in", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.runWithDetails!("Hello", { webSearch: true });
    child.stdout.push("OK\n");
    child.close(0);

    await expect(resultPromise).resolves.toMatchObject({ stdout: "OK" });
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      ...SAFE_DEFAULT_EXEC_ARGS.slice(0, -2),
      "-c",
      'web_search="live"',
      "-c",
      "tools.web_search=true",
    ]);
  });

  it("attaches each locally created image path to the request", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      timeoutMs: 1000,
      spawn,
    });
    const imagePaths = [
      join(tmpdir(), "codexapi-first-cover.png"),
      join(tmpdir(), "codexapi-second-cover.webp"),
    ];

    const resultPromise = runner.runWithDetails!("Hello", { imagePaths });
    child.stdout.push("OK\n");
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
    const runner = createCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      timeoutMs: 1000,
      spawn,
    });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };

    const resultPromise = runner.runWithDetails!("Hello", { outputSchema: schema });
    await waitUntil(() => spawn.mock.calls.length === 1);
    const args = spawn.mock.calls[0]?.[1] ?? [];
    const schemaFlagIndex = args.indexOf("--output-schema");
    const schemaPath = args[schemaFlagIndex + 1];

    expect(schemaFlagIndex).toBeGreaterThan(-1);
    expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual(schema);

    child.stdout.push(`${jsonlCompletion('{"answer":"OK"}')}\n`);
    child.close(0);

    await expect(resultPromise).resolves.toMatchObject({ stdout: '{"answer":"OK"}' });
    await expect(access(schemaPath)).rejects.toThrow();
  });

  it("rejects with a typed error when codex exits non-zero", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: ["C:/codex/codex.js"],
      workspace: "C:/workspace",
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
        cwd: "C:/workspace",
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

  it("kills the child process and rejects when the timeout elapses", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      timeoutMs: 50,
      spawn,
    });

    const resultPromise = runner.run("Hello");
    const expectation = expect(resultPromise).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(51);

    await expectation;
    await resultPromise.catch((error) => {
      expect(error).toBeInstanceOf(CodexRunnerError);
    });
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
