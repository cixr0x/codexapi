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
    "view_image",
    "auth_elicitation",
    "collaboration_modes",
    "enable_request_compression",
    "fast_mode",
    "goals",
    "guardian_approval",
    "in_app_updates",
    "mentions_v2",
    "personality",
    "remote_compaction_v2",
    "secret_auth_storage",
    "skill_search",
    "sqlite",
    "steer",
    "unified_exec",
  ],
  allowedEnabledFeatures: [
    { name: "item_ids", maturity: "removed" },
    { name: "resize_all_images", maturity: "removed" },
    { name: "terminal_resize_reflow", maturity: "removed" },
    { name: "tool_search_always_defer_mcp_tools", maturity: "removed" },
    { name: "tui_app_server", maturity: "removed" },
  ],
  ignoreUserConfig: true,
  ignoreRules: true,
  ephemeral: true,
  strictConfig: true,
};

let tempRoot: string;
let safeCodexHome: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "codexapi-policy-test-"));
  safeCodexHome = join(tempRoot, "codex-home");
  mkdirSync(safeCodexHome);
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Codex execution policy", () => {
  function executionConfig(codexWorkspace: string, codexHome = safeCodexHome) {
    return { codexWorkspace, codexHome };
  }

  it("exposes an immutable, JSON-safe projection of the fixed policy", () => {
    expect(CODEX_EXECUTION_POLICY).toMatchObject(EXPECTED_POLICY);
    expect(Object.isFrozen(CODEX_EXECUTION_POLICY)).toBe(true);
    expect(Object.isFrozen(CODEX_EXECUTION_POLICY.disabledFeatures)).toBe(true);
    expect(Object.isFrozen(CODEX_EXECUTION_POLICY.allowedEnabledFeatures)).toBe(true);
    expect(
      CODEX_EXECUTION_POLICY.allowedEnabledFeatures.every((feature) =>
        Object.isFrozen(feature),
      ),
    ).toBe(true);
    expect(CODEX_EXECUTION_POLICY.disabledFeatures).not.toContain("browser");
    expect(CODEX_EXECUTION_POLICY.disabledFeatures).not.toContain("tool_discovery");

    const health = executionPolicyHealth();
    expect(JSON.parse(JSON.stringify(health))).toEqual(EXPECTED_POLICY);
    expect(health).not.toBe(CODEX_EXECUTION_POLICY);
    expect(health.disabledFeatures).not.toBe(CODEX_EXECUTION_POLICY.disabledFeatures);
    expect(health.allowedEnabledFeatures).not.toBe(
      CODEX_EXECUTION_POLICY.allowedEnabledFeatures,
    );
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
      expect(() => assertSafeExecutionConfig(executionConfig(codexWorkspace))).toThrow(
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
      expect(() => assertSafeExecutionConfig(executionConfig(codexWorkspace))).toThrow(
        "CODEX_WORKSPACE must be outside source and current working directories.",
      );
    },
  );

  it("rejects filesystem roots", () => {
    expect(() =>
      assertSafeExecutionConfig(executionConfig(parse(process.cwd()).root)),
    ).toThrow("CODEX_WORKSPACE must not be a filesystem root.");
  });

  it("rejects a missing workspace", () => {
    expect(() =>
      assertSafeExecutionConfig(executionConfig(join(tempRoot, "missing"))),
    ).toThrow("CODEX_WORKSPACE must exist as an empty directory.");
  });

  it("rejects a workspace that is not a directory", () => {
    const filePath = join(tempRoot, "workspace.txt");
    writeFileSync(filePath, "not a directory", "utf8");

    expect(() => assertSafeExecutionConfig(executionConfig(filePath))).toThrow(
      "CODEX_WORKSPACE must exist as an empty directory.",
    );
  });

  it("rejects a symbolic-link or reparse-point workspace", () => {
    const targetPath = join(tempRoot, "target");
    const linkPath = join(tempRoot, "linked-workspace");
    mkdirSync(targetPath);
    symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");

    expect(() => assertSafeExecutionConfig(executionConfig(linkPath))).toThrow(
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
      assertSafeExecutionConfig(executionConfig(join(linkParent, "workspace"))),
    ).toThrow("CODEX_WORKSPACE must not be a symbolic link or reparse point.");
  });

  it("rejects a non-empty workspace", () => {
    const workspace = join(tempRoot, "non-empty");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "payload.txt"), "content", "utf8");

    expect(() => assertSafeExecutionConfig(executionConfig(workspace))).toThrow(
      "CODEX_WORKSPACE must be empty.",
    );
  });

  it("accepts an explicitly configured dedicated inference directory", () => {
    const workspace = join(tempRoot, "empty-inference");
    mkdirSync(workspace);

    expect(() =>
      assertSafeExecutionConfig(executionConfig(workspace)),
    ).not.toThrow();
  });

  it.each(["", "   ", "relative/codex-home"])(
    "rejects a blank or non-absolute Codex home: %j",
    (codexHome) => {
      const workspace = join(tempRoot, "empty-inference");
      mkdirSync(workspace);

      expect(() =>
        assertSafeExecutionConfig(executionConfig(workspace, codexHome)),
      ).toThrow("CODEX_HOME must be an absolute path.");
    },
  );

  it.each([
    process.cwd(),
    dirname(process.cwd()),
    join(process.cwd(), "nested-codex-home"),
  ])("rejects a source-bearing Codex home: %s", (codexHome) => {
    const workspace = join(tempRoot, "empty-inference");
    mkdirSync(workspace);

    expect(() =>
      assertSafeExecutionConfig(executionConfig(workspace, codexHome)),
    ).toThrow("CODEX_HOME must be outside source and current working directories.");
  });

  it("rejects a filesystem root as the Codex home", () => {
    const workspace = join(tempRoot, "empty-inference");
    mkdirSync(workspace);

    expect(() =>
      assertSafeExecutionConfig(
        executionConfig(workspace, parse(process.cwd()).root),
      ),
    ).toThrow("CODEX_HOME must not be a filesystem root.");
  });

  it("rejects a missing or non-directory Codex home", () => {
    const workspace = join(tempRoot, "empty-inference");
    const homeFile = join(tempRoot, "codex-home.txt");
    mkdirSync(workspace);
    writeFileSync(homeFile, "not a directory", "utf8");

    expect(() =>
      assertSafeExecutionConfig(
        executionConfig(workspace, join(tempRoot, "missing-home")),
      ),
    ).toThrow("CODEX_HOME must exist as a directory.");
    expect(() =>
      assertSafeExecutionConfig(executionConfig(workspace, homeFile)),
    ).toThrow("CODEX_HOME must exist as a directory.");
  });

  it("rejects a symbolic-link or reparse-point Codex home", () => {
    const workspace = join(tempRoot, "empty-inference");
    const targetPath = join(tempRoot, "home-target");
    const linkPath = join(tempRoot, "linked-home");
    mkdirSync(workspace);
    mkdirSync(targetPath);
    symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");

    expect(() =>
      assertSafeExecutionConfig(executionConfig(workspace, linkPath)),
    ).toThrow("CODEX_HOME must not be a symbolic link or reparse point.");
  });

  it("rejects a Codex home reached through a symbolic-link ancestor", () => {
    const workspace = join(tempRoot, "empty-inference");
    const targetParent = join(tempRoot, "home-target-parent");
    const targetHome = join(targetParent, "home");
    const linkParent = join(tempRoot, "linked-home-parent");
    mkdirSync(workspace);
    mkdirSync(targetHome, { recursive: true });
    symlinkSync(
      targetParent,
      linkParent,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      assertSafeExecutionConfig(
        executionConfig(workspace, join(linkParent, "home")),
      ),
    ).toThrow("CODEX_HOME must not be a symbolic link or reparse point.");
  });

  it("accepts a dedicated non-empty Codex home", () => {
    const workspace = join(tempRoot, "empty-inference");
    mkdirSync(workspace);
    writeFileSync(join(safeCodexHome, "auth.json"), "{}", "utf8");

    expect(() =>
      assertSafeExecutionConfig(executionConfig(workspace)),
    ).not.toThrow();
  });
});
