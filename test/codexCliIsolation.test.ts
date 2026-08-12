import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { createCodexChildEnvironment } from "../src/codexRunner.js";
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
    expect(result.stdout.trim()).toBe("codex-cli 0.147.0");
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
    for (const name of CODEX_EXECUTION_POLICY.disabledFeatures) {
      expect(result.stdout).toMatch(
        new RegExp(`^${name}\\s+stable\\s+false$`, "m"),
      );
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
