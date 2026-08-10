import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("pinned Codex CLI isolation", () => {
  it("accepts the strict exec-only base arguments without inference", () => {
    assertSafeExecutionConfig({ codexWorkspace: workspace, codexHome });
    const command = defaultCodexCommand();
    const result = spawnSync(
      command.command,
      [
        ...command.args,
        "exec",
        "-",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        CODEX_EXECUTION_POLICY.sandbox,
        "-c",
        'approval_policy="never"',
        "-c",
        "mcp_servers={}",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--strict-config",
        ...CODEX_EXECUTION_POLICY.disabledFeatures.flatMap((name) => [
          "--disable",
          name,
        ]),
        "-c",
        'web_search="disabled"',
        "--help",
      ],
      {
        cwd: workspace,
        env: createCodexChildEnvironment(codexHome),
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: codex exec");
  });

  it("accepts the fixed config and current feature names without inference", () => {
    assertSafeExecutionConfig({ codexWorkspace: workspace, codexHome });
    const command = defaultCodexCommand();
    const result = spawnSync(
      command.command,
      [
        ...command.args,
        "-c",
        'approval_policy="never"',
        "-c",
        "mcp_servers={}",
        ...CODEX_EXECUTION_POLICY.disabledFeatures.flatMap((name) => [
          "--disable",
          name,
        ]),
        "features",
        "list",
      ],
      {
        cwd: workspace,
        env: createCodexChildEnvironment(codexHome),
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    for (const name of CODEX_EXECUTION_POLICY.disabledFeatures) {
      expect(result.stdout).toContain(name);
    }
  });

  it("has no effective MCP servers in the sanitized dedicated home", () => {
    assertSafeExecutionConfig({ codexWorkspace: workspace, codexHome });
    const command = defaultCodexCommand();
    const result = spawnSync(
      command.command,
      [
        ...command.args,
        "-c",
        "mcp_servers={}",
        "mcp",
        "list",
        "--json",
      ],
      {
        cwd: workspace,
        env: createCodexChildEnvironment(codexHome, {
          ...process.env,
          CODEX_HOME: "C:/attacker-codex-home",
          HOME: "C:/attacker-home",
          USERPROFILE: "C:/attacker-user-profile",
          PATH: "C:/attacker-bin",
          APPDATA: "C:/attacker-appdata",
          CODEX_PLUGIN_PATH: "C:/attacker-plugin",
          MCP_SERVER_COMMAND: "attacker-mcp",
        }),
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("can use credentials established only in the dedicated Codex home", () => {
    const command = defaultCodexCommand();
    const environment = createCodexChildEnvironment(codexHome);
    const login = spawnSync(
      command.command,
      [...command.args, "login", "--with-api-key"],
      {
        cwd: workspace,
        env: environment,
        input: "test-api-key-not-a-secret\n",
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      },
    );

    expect(login.error).toBeUndefined();
    expect(login.status, login.stderr).toBe(0);

    const status = spawnSync(
      command.command,
      [...command.args, "login", "status"],
      {
        cwd: workspace,
        env: environment,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      },
    );
    expect(status.error).toBeUndefined();
    expect(status.status, status.stderr).toBe(0);
    expect(`${status.stdout}\n${status.stderr}`).toContain(
      "Logged in using an API key",
    );
  });
});
