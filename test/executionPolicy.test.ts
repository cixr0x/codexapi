import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

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

  it.each([process.cwd(), dirname(process.cwd())])(
    "rejects a source-bearing workspace: %s",
    (codexWorkspace) => {
      expect(() => assertSafeExecutionConfig({ codexWorkspace })).toThrow(
        "CODEX_WORKSPACE must be a dedicated inference directory.",
      );
    },
  );

  it("accepts an explicitly configured dedicated inference directory", () => {
    expect(() =>
      assertSafeExecutionConfig({
        codexWorkspace: join(process.cwd(), ".codexapi-inference-test"),
      }),
    ).not.toThrow();
  });
});
