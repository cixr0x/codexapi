import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AppConfig } from "./config.js";

export interface CodexRequestCapabilities {
  webSearch: boolean;
  imagePaths: readonly string[];
}

export const CODEX_EXECUTION_POLICY = Object.freeze({
  backend: "exec" as const,
  sandbox: "read-only" as const,
  approvalPolicy: "never" as const,
  disabledFeatures: Object.freeze([
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
  ]),
  ignoreUserConfig: true,
  ignoreRules: true,
  ephemeral: true,
  strictConfig: true,
});

export function executionPolicyHealth() {
  return {
    backend: CODEX_EXECUTION_POLICY.backend,
    sandbox: CODEX_EXECUTION_POLICY.sandbox,
    approvalPolicy: CODEX_EXECUTION_POLICY.approvalPolicy,
    disabledFeatures: [...CODEX_EXECUTION_POLICY.disabledFeatures],
    ignoreUserConfig: CODEX_EXECUTION_POLICY.ignoreUserConfig,
    ignoreRules: CODEX_EXECUTION_POLICY.ignoreRules,
    ephemeral: CODEX_EXECUTION_POLICY.ephemeral,
    strictConfig: CODEX_EXECUTION_POLICY.strictConfig,
  };
}

export function assertSafeExecutionConfig(
  config: Pick<AppConfig, "codexWorkspace">,
): void {
  const workspace = config.codexWorkspace.trim();
  if (!workspace || !isAbsolute(workspace)) {
    throw new Error("CODEX_WORKSPACE must be an absolute path.");
  }

  const moduleParent = dirname(fileURLToPath(import.meta.url));
  const moduleRoot = dirname(moduleParent);
  const unsafeRoots = [
    process.cwd(),
    dirname(process.cwd()),
    moduleRoot,
    dirname(moduleRoot),
  ].map(pathKey);

  if (unsafeRoots.includes(pathKey(workspace))) {
    throw new Error("CODEX_WORKSPACE must be a dedicated inference directory.");
  }
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
