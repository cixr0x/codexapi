import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AppConfig } from "./config.js";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CODEXAPI_CHECKOUT = findPackageRoot(MODULE_DIRECTORY);

export interface CodexRequestCapabilities {
  webSearch: boolean;
  imagePaths: readonly string[];
}

export const CODEX_EXECUTION_POLICY = Object.freeze({
  backend: "exec" as const,
  sandbox: "read-only" as const,
  approvalPolicy: "never" as const,
  mcpServers: "disabled" as const,
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
    mcpServers: CODEX_EXECUTION_POLICY.mcpServers,
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

  const resolvedWorkspace = resolve(workspace);
  if (pathKey(resolvedWorkspace) === pathKey(parse(resolvedWorkspace).root)) {
    throw new Error("CODEX_WORKSPACE must not be a filesystem root.");
  }

  if (
    [process.cwd(), CODEXAPI_CHECKOUT].some((protectedPath) =>
      pathsOverlap(resolvedWorkspace, protectedPath),
    )
  ) {
    throw new Error(
      "CODEX_WORKSPACE must be outside source and current working directories.",
    );
  }

  let workspaceStat;
  try {
    workspaceStat = lstatSync(resolvedWorkspace);
  } catch {
    throw new Error("CODEX_WORKSPACE must exist as an empty directory.");
  }

  if (workspaceStat.isSymbolicLink()) {
    throw new Error(
      "CODEX_WORKSPACE must not be a symbolic link or reparse point.",
    );
  }

  if (!workspaceStat.isDirectory()) {
    throw new Error("CODEX_WORKSPACE must exist as an empty directory.");
  }

  let canonicalWorkspace;
  try {
    canonicalWorkspace = realpathSync.native(resolvedWorkspace);
  } catch {
    throw new Error("CODEX_WORKSPACE must exist as an empty directory.");
  }

  if (pathKey(canonicalWorkspace) !== pathKey(resolvedWorkspace)) {
    throw new Error(
      "CODEX_WORKSPACE must not be a symbolic link or reparse point.",
    );
  }

  if (readdirSync(resolvedWorkspace).length !== 0) {
    throw new Error("CODEX_WORKSPACE must be empty.");
  }
}

function findPackageRoot(start: string): string {
  let current = resolve(start);

  while (true) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(start);
    }
    current = parent;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftKey = pathKey(left);
  const rightKey = pathKey(right);
  return isSameOrDescendant(leftKey, rightKey) || isSameOrDescendant(rightKey, leftKey);
}

function isSameOrDescendant(candidate: string, base: string): boolean {
  const relation = relative(base, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
