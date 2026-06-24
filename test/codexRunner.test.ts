import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  CodexRunnerError,
  createCodexRunner,
  type SpawnFn,
} from "../src/codexRunner.js";

class FakeReadable extends EventEmitter {
  push(chunk: string | null): void {
    if (chunk !== null) {
      this.emit("data", chunk);
    }
  }
}

class FakeChildProcess extends EventEmitter {
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

describe("Codex runner", () => {
  it("invokes codex exec with the expected arguments and workspace", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      profile: "plain",
      ignoreUserConfig: true,
      disablePlugins: true,
      disableShellSnapshot: true,
      ephemeral: true,
      ignoreRules: true,
      timeoutMs: 1000,
      spawn,
    });

    const resultPromise = runner.run("Hello");
    child.stdout.push("Hi\n");
    child.close(0);

    await expect(resultPromise).resolves.toBe("Hi");
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "Hello",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--disable",
        "plugins",
        "--disable",
        "shell_snapshot",
        "--ephemeral",
        "--ignore-rules",
      ],
      expect.objectContaining({
        cwd: "C:/workspace",
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it("returns stdout and stderr from detailed runs", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      profile: "plain",
      ignoreUserConfig: true,
      disablePlugins: true,
      disableShellSnapshot: true,
      ephemeral: true,
      ignoreRules: true,
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
      stderr: "skill loader warning",
      command: {
        executable: "codex",
        args: [
          "exec",
          "Hello",
          "--skip-git-repo-check",
          "--ignore-user-config",
          "--disable",
          "plugins",
          "--disable",
          "shell_snapshot",
          "--ephemeral",
          "--ignore-rules",
        ],
        cwd: "C:/workspace",
        shell: false,
      },
    });
  });

  it("passes request model and reasoning effort to codex exec", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: [],
      workspace: "C:/workspace",
      profile: "plain",
      ignoreUserConfig: true,
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
        "exec",
        "Hello",
        "--skip-git-repo-check",
        "--model",
        "gpt-5.4-mini",
        "-c",
        "model_reasoning_effort=\"medium\"",
        "--ignore-user-config",
      ],
      expect.objectContaining({
        cwd: "C:/workspace",
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it("rejects with a typed error when codex exits non-zero", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const runner = createCodexRunner({
      command: "codex",
      commandArgs: ["C:/codex/codex.js"],
      workspace: "C:/workspace",
      profile: "plain",
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
        args: [
          "C:/codex/codex.js",
          "exec",
          "Hello",
          "--skip-git-repo-check",
          "--profile",
          "plain",
        ],
        cwd: "C:/workspace",
        shell: false,
      },
    });
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      [
        "C:/codex/codex.js",
        "exec",
        "Hello",
        "--skip-git-repo-check",
        "--profile",
        "plain",
      ],
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
      profile: "plain",
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
      profile: "plain",
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
