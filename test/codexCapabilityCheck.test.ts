import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { SpawnFn } from "../src/codexRunner.js";
import { assertCodexCapabilities } from "../src/codexCapabilityCheck.js";
import { CODEX_EXECUTION_POLICY } from "../src/executionPolicy.js";

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

const PINNED_FEATURE_OUTPUT = [
  "shell_tool stable false",
  "shell_snapshot stable false",
  "unified_exec stable false",
  "browser_use stable true",
  "browser_use_external stable true",
  "code_mode under development true",
  "code_mode_host stable true",
  "in_app_browser stable true",
  "view_image stable true",
  "apps stable true",
  "multi_agent stable true",
].join("\n") + "\n";

function successfulProbe(featureOutput = PINNED_FEATURE_OUTPUT): ProbeSpawn {
  return createProbeSpawn([
    { stdout: "codex-cli 0.147.0\n" },
    { stdout: featureOutput },
    { stdout: "[]\n" },
  ]);
}

describe("Codex capability startup check", () => {
  it("accepts required capable features, prohibited shell features, and unrelated enabled features", async () => {
    const spawn = successfulProbe();

    await expect(assertCodexCapabilities(testConfig(), spawn)).resolves.toEqual({
      version: "0.147.0",
      requiredFeatures: [
        "browser_use",
        "browser_use_external",
        "code_mode",
        "code_mode_host",
        "in_app_browser",
        "view_image",
      ],
      disabledFeatures: ["shell_tool", "shell_snapshot", "unified_exec"],
      permissionProfile: "codexapi-runtime",
      webSearch: "live",
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
      expect.arrayContaining([
        "--profile",
        "codexapi-runtime",
        "--enable",
        "browser_use",
        "--enable",
        "view_image",
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        'web_search="live"',
        "tools.web_search=true",
        "features",
        "list",
      ]),
    );
    expect(spawn.calls[1]?.[1]).not.toEqual(
      expect.arrayContaining([
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--strict-config",
      ]),
    );
    expect(spawn.calls[2]?.[1]).toEqual(
      expect.arrayContaining([
        "--profile",
        "codexapi-runtime",
        "mcp_servers={}",
        "mcp",
        "list",
        "--json",
      ]),
    );
  });

  it.each([
    ["an older version", "codex-cli 0.146.0\n", /requires exact Codex CLI 0\.147\.0/i],
    ["a newer untested version", "codex-cli 0.147.1\n", /requires exact Codex CLI 0\.147\.0/i],
    ["unparseable version output", "Codex version unknown\n", /version output was not recognized/i],
  ])("rejects %s before inspecting features", async (_name, versionOutput, message) => {
    const spawn = createProbeSpawn([{ stdout: versionOutput }]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(message);
    expect(spawn.calls).toHaveLength(1);
  });

  it.each(
    CODEX_EXECUTION_POLICY.requiredFeatures.flatMap((feature) => [
      [
        feature.name,
        "missing",
        PINNED_FEATURE_OUTPUT.replace(`${feature.name} ${feature.maturity} true\n`, ""),
        new RegExp(`Codex ${feature.name} feature was not reported`, "i"),
      ],
      [
        feature.name,
        "false",
        PINNED_FEATURE_OUTPUT.replace(
          `${feature.name} ${feature.maturity} true`,
          `${feature.name} ${feature.maturity} false`,
        ),
        new RegExp(`Codex ${feature.name} feature is incompatible with this policy`, "i"),
      ],
      [
        feature.name,
        "maturity drift",
        PINNED_FEATURE_OUTPUT.replace(
          `${feature.name} ${feature.maturity} true`,
          `${feature.name} deprecated true`,
        ),
        new RegExp(`Codex ${feature.name} feature is incompatible with this policy`, "i"),
      ],
    ]),
  )("rejects required feature %s when it is %s", async (_name, _state, featureOutput, message) => {
    const spawn = successfulProbe(featureOutput);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(message);
    expect(spawn.calls).toHaveLength(2);
  });

  it.each(CODEX_EXECUTION_POLICY.disabledFeatures)(
    "rejects prohibited feature %s when it is enabled",
    async (name) => {
      const spawn = successfulProbe(
        PINNED_FEATURE_OUTPUT.replace(`${name} stable false`, `${name} stable true`),
      );

      await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
        new RegExp(`Codex ${name} feature is enabled despite the disable policy`, "i"),
      );
      expect(spawn.calls).toHaveLength(2);
    },
  );

  it.each([
    [
      "a malformed nonblank row",
      `${PINNED_FEATURE_OUTPUT}malformed row\n`,
      /feature output contained a malformed row/i,
    ],
    [
      "a duplicate row",
      `${PINNED_FEATURE_OUTPUT}apps stable true\n`,
      /apps feature is incompatible/i,
    ],
  ])("rejects %s", async (_name, featureOutput, message) => {
    const spawn = successfulProbe(featureOutput);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(message);
    expect(spawn.calls).toHaveLength(2);
  });

  it("fails closed when multibyte probe output exceeds the 64 KiB byte cap", async () => {
    const spawn = successfulProbe(`${PINNED_FEATURE_OUTPUT}${"é".repeat(64 * 1024)}`);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /feature probe output exceeded 65536 bytes/i,
    );
    expect(spawn.calls).toHaveLength(2);
  });

  it("rejects a nonempty MCP inventory", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      { stdout: PINNED_FEATURE_OUTPUT },
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
