import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { SpawnFn } from "../src/codexRunner.js";
import { assertCodexCapabilities } from "../src/codexCapabilityCheck.js";

class FakeReadable extends EventEmitter {}

class FakeChildProcess extends EventEmitter {
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  kill = vi.fn();
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

  it("times out a probe that does not exit", async () => {
    const spawn = createProbeSpawn([{ neverClose: true }]);

    await expect(assertCodexCapabilities(testConfig(10), spawn)).rejects.toThrow(
      /timed out/i,
    );
  });
});
