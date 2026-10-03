import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { createCodexChildEnvironment } from "../src/codexRunner.js";
import { assertCodexCapabilities } from "../src/codexCapabilityCheck.js";
import { defaultCodexCommand } from "../src/config.js";
import {
  CODEX_EXECUTION_POLICY,
  assertSafeExecutionConfig,
} from "../src/executionPolicy.js";

const tempRoot = mkdtempSync(join(tmpdir(), "codexapi-cli-isolation-test-"));
const workspace = join(tempRoot, "workspace");
const codexHome = join(tempRoot, "codex-home");
mkdirSync(workspace);
mkdirSync(codexHome);
copyFileSync(
  fileURLToPath(new URL("../deploy/codexapi-runtime.config.toml", import.meta.url)),
  join(codexHome, "codexapi-runtime.config.toml"),
);
// A home-local requirements file is deliberately insufficient. Only Codex's
// supported administrator layer can enforce unified_exec=false.
copyFileSync(
  fileURLToPath(new URL("../deploy/codex-managed/requirements.toml", import.meta.url)),
  join(codexHome, "requirements.toml"),
);
const requireManagedPolicy = process.env.CODEXAPI_TEST_REQUIRE_MANAGED_POLICY === "1";

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function runtimeFeatureArgs(): string[] {
  return [
    "-c",
    `approval_policy="${CODEX_EXECUTION_POLICY.approvalPolicy}"`,
    "-c",
    "mcp_servers={}",
    ...CODEX_EXECUTION_POLICY.requiredFeatures.flatMap(({ name }) => ["--enable", name]),
    ...CODEX_EXECUTION_POLICY.disabledFeatures.flatMap((name) => ["--disable", name]),
    "-c",
    'web_search="live"',
    "-c",
    "tools.web_search=true",
  ];
}

function runProbe(args: string[]) {
  const command = defaultCodexCommand();
  return spawnSync(command.command, [...command.args, ...args], {
    cwd: workspace,
    env: createCodexChildEnvironment(codexHome),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
}

describe("pinned Codex CLI isolation", () => {
  it("reports the exact pinned Codex CLI version without inference", () => {
    assertSafeExecutionConfig({ codexWorkspace: workspace, codexHome });
    const result = runProbe(["--version"]);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("codex-cli 0.160.0");
  });

  it("reports required capable features and prohibited shell features without loading the runtime profile", () => {
    assertSafeExecutionConfig({ codexWorkspace: workspace, codexHome });
    const result = runProbe([...runtimeFeatureArgs(), "features", "list"]);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    for (const { name, maturity } of CODEX_EXECUTION_POLICY.requiredFeatures) {
      expect(result.stdout).toMatch(
        new RegExp(`^${name}\\s+${maturity}\\s+true$`, "m"),
      );
    }
    for (const name of ["shell_tool", "shell_snapshot"]) {
      expect(result.stdout).toMatch(
        new RegExp(`^${name}\\s+stable\\s+false$`, "m"),
      );
    }
    expect(result.stdout).toMatch(/^unified_exec\s+stable\s+(true|false)$/m);
    if (requireManagedPolicy) {
      expect(result.stdout).toMatch(/^unified_exec\s+stable\s+false$/m);
    }
  });

  it("accepts managed requirements or rejects unenforced unified execution before inference", async () => {
    const featureResult = runProbe([...runtimeFeatureArgs(), "features", "list"]);
    expect(featureResult.error).toBeUndefined();
    expect(featureResult.status, featureResult.stderr).toBe(0);
    const unifiedExecDisabled = /^unified_exec\s+stable\s+false$/m.test(featureResult.stdout);
    const attestation = assertCodexCapabilities({
      codexWorkspace: workspace,
      codexHome,
      codexTimeoutMs: 20_000,
    });

    if (!unifiedExecDisabled) {
      await expect(attestation).rejects.toThrow(/unified_exec.*managed requirements/i);
      expect(requireManagedPolicy, "Linux release gates must enforce the managed policy").toBe(false);
    } else if (process.platform === "win32") {
      // The production profile contains POSIX filesystem paths and is not a
      // native-Windows runtime profile, even when administrator policy exists.
      await expect(attestation).rejects.toThrow(/MCP inventory probe exited/i);
      expect(requireManagedPolicy, "Managed production gates must run on Linux").toBe(false);
    } else {
      await expect(attestation).resolves.toMatchObject({ version: "0.160.0", checked: true });
      const attemptedOverride = runProbe(["--enable", "unified_exec", "features", "list"]);
      expect(attemptedOverride.error).toBeUndefined();
      expect(attemptedOverride.status, attemptedOverride.stderr).toBe(0);
      expect(attemptedOverride.stdout).toMatch(/^unified_exec\s+stable\s+false$/m);
    }
  });

  it.skipIf(process.platform === "win32")(
    "has no effective MCP servers in the sanitized dedicated home (skipped on Windows because the production profile has POSIX filesystem paths)",
    () => {
      assertSafeExecutionConfig({ codexWorkspace: workspace, codexHome });
      const result = runProbe([
        "--profile",
        CODEX_EXECUTION_POLICY.permissionProfile,
        "-c",
        "mcp_servers={}",
        "mcp",
        "list",
        "--json",
      ]);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    },
  );
});
