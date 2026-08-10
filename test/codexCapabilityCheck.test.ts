import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { SpawnFn } from "../src/codexRunner.js";
import { assertCodexCapabilities } from "../src/codexCapabilityCheck.js";

class FakeReadable extends EventEmitter {}

class FakeChildProcess extends EventEmitter {
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  kill = vi.fn();

  close(code: number | null): void {
    this.emit("close", code, null);
  }

  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

interface ProbeResult {
  code?: number;
  stdout?: string;
  stderr?: string;
  neverClose?: boolean;
}

interface ProbeSpawn extends SpawnFn {
  calls: Array<[string, string[], Parameters<SpawnFn>[2]]>;
}

function createProbeSpawn(results: ProbeResult[]): ProbeSpawn {
  const calls: ProbeSpawn["calls"] = [];
  const spawn = ((
    command: string,
    args: string[],
    options: Parameters<SpawnFn>[2],
  ) => {
    calls.push([command, args, options]);
    const child = new FakeChildProcess();
    const result = results.shift();
    if (!result) {
      throw new Error("Unexpected capability probe.");
    }

    if (!result.neverClose) {
      queueMicrotask(() => {
        if (result.stdout) {
          child.stdout.emit("data", result.stdout);
        }
        if (result.stderr) {
          child.stderr.emit("data", result.stderr);
        }
        child.emit("close", result.code ?? 0, null);
      });
    }

    return child as never;
  }) as unknown as ProbeSpawn;
  spawn.calls = calls;
  return spawn;
}

function createManualProbeSpawn(child: FakeChildProcess): ProbeSpawn {
  const calls: ProbeSpawn["calls"] = [];
  const spawn = ((
    command: string,
    args: string[],
    options: Parameters<SpawnFn>[2],
  ) => {
    calls.push([command, args, options]);
    return child as never;
  }) as unknown as ProbeSpawn;
  spawn.calls = calls;
  return spawn;
}

function testConfig(timeoutMs = 100): {
  codexWorkspace: string;
  codexHome: string;
  codexTimeoutMs: number;
} {
  return {
    codexWorkspace: "C:/dedicated-inference-workspace",
    codexHome: "C:/dedicated-codex-home",
    codexTimeoutMs: timeoutMs,
  };
}

describe("Codex capability startup check", () => {
  it("accepts the pinned CLI with a recognized shell tool feature and no MCP servers", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.144.1\n" },
      { stdout: "shell_tool                           stable             false\n" },
      { stdout: "[]\n" },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).resolves.toEqual({
      version: "0.144.1",
      shellToolFeature: "stable",
      checked: true,
    });
    expect(spawn.calls[0]).toEqual([
      expect.any(String),
      ["--version"],
      expect.objectContaining({
        cwd: "C:/dedicated-inference-workspace",
        shell: false,
        windowsHide: true,
        env: expect.objectContaining({
          CODEX_HOME: "C:/dedicated-codex-home",
          HOME: "C:/dedicated-codex-home",
          USERPROFILE: "C:/dedicated-codex-home",
        }),
      }),
    ]);
    expect(spawn.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["features", "list", "--disable", "shell_tool"]),
    );
    expect(spawn.calls[2]?.[1]).toEqual(
      expect.arrayContaining(["mcp", "list", "--json", "mcp_servers={}"]),
    );
  });

  it.each([
    ["an older version", "codex-cli 0.144.0\n", /requires Codex CLI 0\.144\.1 or newer/i],
    ["an older minor version", "codex-cli 0.143.99\n", /requires Codex CLI 0\.144\.1 or newer/i],
    ["unparseable version output", "Codex version unknown\n", /version output was not recognized/i],
  ])("rejects %s before inspecting features", async (_name, versionOutput, message) => {
    const spawn = createProbeSpawn([{ stdout: versionOutput }]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(message);
    expect(spawn.calls).toHaveLength(1);
  });

  it.each([
    "codex-cli 0.144.1 extra\n",
    "codex-cli 0.144.1-beta\n",
    "codex-cli 0.144.1\ncodex-cli 0.144.1\n",
    "codex-cli 999999999999999999999.144.1\n",
    "codex-cli 01.144.1\n",
    "Codex-cli 0.144.1\n",
  ])("rejects malformed complete version output %j", async (versionOutput) => {
    const spawn = createProbeSpawn([{ stdout: versionOutput }]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /version output was not recognized/i,
    );
    expect(spawn.calls).toHaveLength(1);
  });

  it("rejects a nonzero version probe", async () => {
    const spawn = createProbeSpawn([{ code: 1, stderr: "bad executable" }]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /version probe exited with code 1/i,
    );
  });

  it.each([
    ["a missing shell tool feature", "apps stable true\n", /shell_tool feature was not reported/i],
    ["an incompatible shell tool feature", "shell_tool removed false\n", /shell_tool feature is incompatible/i],
  ])("rejects %s", async (_name, featureOutput, message) => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.144.1\n" },
      { stdout: featureOutput },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(message);
  });

  it.each([
    "shell_tool stable false trailing\n",
    "shell_tool removed false\n",
    "shell_tool stable false\nshell_tool experimental false\n",
    "shell_tool stable false\nshell_tool stable false\n",
    "shell_tool stable maybe\n",
  ])("rejects malformed or ambiguous shell_tool output %j", async (featureOutput) => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.144.1\n" },
      { stdout: featureOutput },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /shell_tool feature is incompatible/i,
    );
  });

  it("rejects a nonempty MCP inventory", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.144.1\n" },
      { stdout: "shell_tool experimental false\n" },
      { stdout: '[{"name":"unexpected"}]\n' },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /MCP inventory is not empty/i,
    );
  });

  it("waits for close after SIGTERM and ignores exit before close", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const result = assertCodexCapabilities(testConfig(1), createManualProbeSpawn(child));
    let settled = false;
    void result.finally(() => {
      settled = true;
    }).catch(() => undefined);

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(settled).toBe(false);

      child.exit(null);
      await Promise.resolve();
      expect(settled).toBe(false);

      child.close(null);
      await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(vi.getTimerCount()).toBe(0);
      expect(child.eventNames()).toEqual([]);
      expect(child.stdout.eventNames()).toEqual([]);
      expect(child.stderr.eventNames()).toEqual([]);
    } finally {
      child.close(null);
      await result.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("force-kills an ignored SIGTERM and still waits for close", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const result = assertCodexCapabilities(testConfig(1), createManualProbeSpawn(child));

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

      child.close(null);
      await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(vi.getTimerCount()).toBe(0);
      expect(child.eventNames()).toEqual([]);
      expect(child.stdout.eventNames()).toEqual([]);
      expect(child.stderr.eventNames()).toEqual([]);
    } finally {
      child.close(null);
      await result.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("returns a bounded fatal error and reaps a child when SIGKILL is not verified", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    child.kill.mockReturnValue(false);
    const result = assertCodexCapabilities(testConfig(1), createManualProbeSpawn(child));
    const fatalResult = result.catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(fatalResult).resolves.toMatchObject({
        code: "TERMINATION_FAILED",
        childMayBeRunning: true,
      });
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(child.listenerCount("close")).toBe(1);
      expect(child.listenerCount("error")).toBe(1);
      expect(child.stdout.eventNames()).toEqual([]);
      expect(child.stderr.eventNames()).toEqual([]);

      child.close(null);
      await Promise.resolve();
      expect(child.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.close(null);
      await fatalResult;
      vi.useRealTimers();
    }
  });
});
