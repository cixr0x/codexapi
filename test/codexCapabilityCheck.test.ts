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

const DISABLED_FEATURE_OUTPUT = [
  "apply_patch_freeform removed false",
  "shell_tool stable false",
  "apps stable false",
  "plugins stable false",
  "shell_snapshot stable false",
  "browser_use stable false",
  "browser_use_external stable false",
  "browser_use_full_cdp_access stable false",
  "in_app_browser stable false",
  "computer_use stable false",
  "code_mode under development false",
  "image_generation stable false",
  "multi_agent stable false",
  "memories experimental false",
  "hooks stable false",
  "tool_suggest stable false",
  "enable_mcp_apps under development false",
  "skill_mcp_dependency_install stable false",
  "tool_call_mcp_elicitation stable false",
  "code_mode_host stable false",
  "remote_plugin stable false",
  "plugin_sharing stable false",
  "enable_fanout under development false",
  "workspace_dependencies stable false",
  "view_image stable false",
  "auth_elicitation stable false",
  "collaboration_modes removed false",
  "enable_request_compression stable false",
  "fast_mode stable false",
  "goals stable false",
  "guardian_approval stable false",
  "in_app_updates stable false",
  "item_ids removed true",
  "mentions_v2 stable false",
  "personality stable false",
  "remote_compaction_v2 stable false",
  "resize_all_images removed true",
  "secret_auth_storage stable false",
  "skill_search stable false",
  "sqlite removed false",
  "steer removed false",
  "terminal_resize_reflow removed true",
  "tool_search_always_defer_mcp_tools removed true",
  "tui_app_server removed true",
  "use_legacy_landlock deprecated false",
].join("\n") + "\n";

describe("Codex capability startup check", () => {
  it("accepts the pinned CLI with a recognized shell tool feature and no MCP servers", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      { stdout: DISABLED_FEATURE_OUTPUT },
      { stdout: "[]\n" },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).resolves.toEqual({
      version: "0.147.0",
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
      expect.arrayContaining([
        "features",
        "list",
        "--disable",
        "shell_tool",
        "--disable",
        "view_image",
      ]),
    );
    expect(spawn.calls[1]?.[1]).not.toContain("--strict-config");
    expect(spawn.calls[2]?.[1]).toEqual(
      expect.arrayContaining(["mcp", "list", "--json", "mcp_servers={}"]),
    );
    expect(spawn.calls[2]?.[1]).not.toContain("--strict-config");
  });

  it.each([
    ["an older version", "codex-cli 0.146.0\n", /requires exact Codex CLI 0\.147\.0/i],
    ["an older minor version", "codex-cli 0.144.99\n", /requires exact Codex CLI 0\.147\.0/i],
    ["a newer untested version", "codex-cli 0.147.1\n", /requires exact Codex CLI 0\.147\.0/i],
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
    [
      "a missing shell tool feature",
      DISABLED_FEATURE_OUTPUT.replace("shell_tool stable false\n", ""),
      /shell_tool feature was not reported/i,
    ],
    ["an incompatible shell tool feature", "shell_tool removed false\n", /shell_tool feature is incompatible/i],
  ])("rejects %s", async (_name, featureOutput, message) => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
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
      { stdout: "codex-cli 0.147.0\n" },
      { stdout: featureOutput },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /shell_tool feature is incompatible/i,
    );
  });

  it("rejects shell_tool reported enabled despite the disable override", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      { stdout: "shell_tool stable true\n" },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /shell_tool feature is enabled/i,
    );
    expect(spawn.calls).toHaveLength(2);
  });

  it("rejects any other fixed-disabled feature reported enabled", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      {
        stdout: DISABLED_FEATURE_OUTPUT.replace(
          "computer_use stable false",
          "computer_use stable true",
        ),
      },
      { stdout: "[]\n" },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /computer_use feature is enabled/i,
    );
    expect(spawn.calls).toHaveLength(2);
  });

  it("rejects a missing fixed-disabled feature row", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      {
        stdout: DISABLED_FEATURE_OUTPUT.replace("apps stable false\n", ""),
      },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /apps feature was not reported/i,
    );
    expect(spawn.calls).toHaveLength(2);
  });

  it("rejects a malformed fixed-disabled feature maturity column", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      {
        stdout: DISABLED_FEATURE_OUTPUT.replace(
          "computer_use stable false",
          "computer_use stable true false",
        ),
      },
      { stdout: "[]\n" },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /computer_use feature is incompatible/i,
    );
    expect(spawn.calls).toHaveLength(2);
  });

  it.each([
    ["a malformed nonblank row", `${DISABLED_FEATURE_OUTPUT}malformed row\n`, /malformed feature is incompatible/i],
    [
      "a duplicate non-policy row",
      `${DISABLED_FEATURE_OUTPUT}apply_patch_freeform removed false\n`,
      /apply_patch_freeform feature is incompatible/i,
    ],
    [
      "an unknown maturity",
      `${DISABLED_FEATURE_OUTPUT}future_feature preview false\n`,
      /future_feature feature is incompatible/i,
    ],
    [
      "an unexpected enabled stable feature",
      `${DISABLED_FEATURE_OUTPUT}future_feature stable true\n`,
      /future_feature feature is enabled/i,
    ],
    [
      "an enabled removed feature",
      DISABLED_FEATURE_OUTPUT.replace(
        "apply_patch_freeform removed false",
        "apply_patch_freeform removed true",
      ),
      /apply_patch_freeform feature is enabled/i,
    ],
  ])("rejects complete feature output containing %s", async (_name, featureOutput, message) => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      { stdout: featureOutput },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(message);
    expect(spawn.calls).toHaveLength(2);
  });

  it("rejects maturity drift for an explicitly allowlisted removed row", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      {
        stdout: DISABLED_FEATURE_OUTPUT.replace(
          "item_ids removed true",
          "item_ids stable true",
        ),
      },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /item_ids feature is enabled/i,
    );
    expect(spawn.calls).toHaveLength(2);
  });

  it.each([
    [
      "missing",
      DISABLED_FEATURE_OUTPUT.replace("view_image stable false\n", ""),
      /view_image feature was not reported/i,
    ],
    [
      "enabled",
      DISABLED_FEATURE_OUTPUT.replace("view_image stable false", "view_image stable true"),
      /view_image feature is enabled/i,
    ],
    [
      "incompatible",
      DISABLED_FEATURE_OUTPUT.replace("view_image stable false", "view_image preview false"),
      /view_image feature is incompatible/i,
    ],
    [
      "duplicate",
      DISABLED_FEATURE_OUTPUT.replace(
        "view_image stable false",
        "view_image stable false\nview_image stable false",
      ),
      /view_image feature is incompatible/i,
    ],
  ])("rejects %s view_image startup evidence", async (_name, featureOutput, message) => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      { stdout: featureOutput },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(message);
    expect(spawn.calls).toHaveLength(2);
  });

  it("fails closed when multibyte probe output exceeds the 64 KiB byte cap", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      { stdout: `shell_tool stable false\n${"é".repeat(64 * 1024)}` },
    ]);

    await expect(assertCodexCapabilities(testConfig(), spawn)).rejects.toThrow(
      /feature probe output exceeded 65536 bytes/i,
    );
    expect(spawn.calls).toHaveLength(2);
  });

  it("rejects a nonempty MCP inventory", async () => {
    const spawn = createProbeSpawn([
      { stdout: "codex-cli 0.147.0\n" },
      {
        stdout: DISABLED_FEATURE_OUTPUT.replace(
          "shell_tool stable false",
          "shell_tool experimental false",
        ),
      },
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
