import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODEX_EXECUTION_POLICY,
  assertSafeExecutionConfig,
  executionPolicyHealth,
  type CodexRequestCapabilities,
} from "../src/executionPolicy.js";

const EXPECTED_POLICY = {
  backend: "exec",
  sandbox: "read-only",
  approvalPolicy: "never",
  mcpServers: "disabled",
  disabledFeatures: [
    "shell_tool",
    "apps",
    "plugins",
    "shell_snapshot",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "in_app_browser",
    "computer_use",
    "code_mode",
    "image_generation",
    "multi_agent",
    "memories",
    "hooks",
    "tool_suggest",
    "enable_mcp_apps",
    "skill_mcp_dependency_install",
    "tool_call_mcp_elicitation",
    "code_mode_host",
    "remote_plugin",
    "plugin_sharing",
    "enable_fanout",
    "workspace_dependencies",
  ],
  ignoreUserConfig: true,
  ignoreRules: true,
  ephemeral: true,
  strictConfig: true,
};

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "codexapi-policy-test-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Codex execution policy", () => {
  it("exposes an immutable, JSON-safe projection of the fixed policy", () => {
    expect(CODEX_EXECUTION_POLICY).toMatchObject(EXPECTED_POLICY);
    expect(Object.isFrozen(CODEX_EXECUTION_POLICY)).toBe(true);
    expect(Object.isFrozen(CODEX_EXECUTION_POLICY.disabledFeatures)).toBe(true);
    expect(CODEX_EXECUTION_POLICY.disabledFeatures).not.toContain("browser");
    expect(CODEX_EXECUTION_POLICY.disabledFeatures).not.toContain("tool_discovery");

    const health = executionPolicyHealth();
    expect(JSON.parse(JSON.stringify(health))).toEqual(EXPECTED_POLICY);
    expect(health).not.toBe(CODEX_EXECUTION_POLICY);
    expect(health.disabledFeatures).not.toBe(CODEX_EXECUTION_POLICY.disabledFeatures);
  });

  it("defines normalized per-request capabilities", () => {
    const capabilities: CodexRequestCapabilities = {
      webSearch: false,
      imagePaths: [],
    };

    expect(capabilities).toEqual({ webSearch: false, imagePaths: [] });
  });

  it.each(["", "   ", "relative/inference"])(
    "rejects a blank or non-absolute workspace: %j",
    (codexWorkspace) => {
      expect(() => assertSafeExecutionConfig({ codexWorkspace })).toThrow(
        "CODEX_WORKSPACE must be an absolute path.",
      );
    },
  );

  it.each([
    process.cwd(),
    dirname(process.cwd()),
    join(process.cwd(), "nested-inference"),
  ])(
    "rejects a source-bearing workspace: %s",
    (codexWorkspace) => {
      expect(() => assertSafeExecutionConfig({ codexWorkspace })).toThrow(
        "CODEX_WORKSPACE must be outside source and current working directories.",
      );
    },
  );

  it("rejects filesystem roots", () => {
    expect(() =>
      assertSafeExecutionConfig({ codexWorkspace: parse(process.cwd()).root }),
    ).toThrow("CODEX_WORKSPACE must not be a filesystem root.");
  });

  it("rejects a missing workspace", () => {
    expect(() =>
      assertSafeExecutionConfig({ codexWorkspace: join(tempRoot, "missing") }),
    ).toThrow("CODEX_WORKSPACE must exist as an empty directory.");
  });

  it("rejects a workspace that is not a directory", () => {
    const filePath = join(tempRoot, "workspace.txt");
    writeFileSync(filePath, "not a directory", "utf8");

    expect(() => assertSafeExecutionConfig({ codexWorkspace: filePath })).toThrow(
      "CODEX_WORKSPACE must exist as an empty directory.",
    );
  });

  it("rejects a symbolic-link or reparse-point workspace", () => {
    const targetPath = join(tempRoot, "target");
    const linkPath = join(tempRoot, "linked-workspace");
    mkdirSync(targetPath);
    symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");

    expect(() => assertSafeExecutionConfig({ codexWorkspace: linkPath })).toThrow(
      "CODEX_WORKSPACE must not be a symbolic link or reparse point.",
    );
  });

  it("rejects a workspace reached through a symbolic-link ancestor", () => {
    const targetParent = join(tempRoot, "target-parent");
    const targetWorkspace = join(targetParent, "workspace");
    const linkParent = join(tempRoot, "linked-parent");
    mkdirSync(targetWorkspace, { recursive: true });
    symlinkSync(
      targetParent,
      linkParent,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      assertSafeExecutionConfig({ codexWorkspace: join(linkParent, "workspace") }),
    ).toThrow("CODEX_WORKSPACE must not be a symbolic link or reparse point.");
  });

  it("rejects a non-empty workspace", () => {
    const workspace = join(tempRoot, "non-empty");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "payload.txt"), "content", "utf8");

    expect(() => assertSafeExecutionConfig({ codexWorkspace: workspace })).toThrow(
      "CODEX_WORKSPACE must be empty.",
    );
  });

  it("accepts an explicitly configured dedicated inference directory", () => {
    const workspace = join(tempRoot, "empty-inference");
    mkdirSync(workspace);

    expect(() =>
      assertSafeExecutionConfig({ codexWorkspace: workspace }),
    ).not.toThrow();
  });
});
