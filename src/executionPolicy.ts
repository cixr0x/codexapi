import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AppConfig } from "./config.js";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CODEXAPI_CHECKOUT = findPackageRoot(MODULE_DIRECTORY);

export const CODEX_EXECUTION_POLICY = Object.freeze({
  backend: "exec" as const,
  permissionProfile: "codexapi-runtime" as const,
  approvalPolicy: "never" as const,
  mcpServers: "empty" as const,
  defaultWebSearch: true as const,
  disabledFeatures: Object.freeze([
    "shell_tool",
    "shell_snapshot",
    "unified_exec",
  ]),
  requiredFeatures: Object.freeze([
    Object.freeze({ name: "browser_use", maturity: "stable" as const }),
    Object.freeze({ name: "browser_use_external", maturity: "stable" as const }),
    Object.freeze({ name: "code_mode", maturity: "under development" as const }),
    Object.freeze({ name: "code_mode_host", maturity: "stable" as const }),
    Object.freeze({ name: "in_app_browser", maturity: "stable" as const }),
    Object.freeze({ name: "view_image", maturity: "stable" as const }),
  ]),
  // Retained only until the deferred runner and capability-attestation tasks
  // consume the profile and requiredFeatures contracts above.
  sandbox: "read-only" as const,
  allowedEnabledFeatures: Object.freeze([
    Object.freeze({ name: "item_ids", maturity: "removed" as const }),
    Object.freeze({ name: "resize_all_images", maturity: "removed" as const }),
    Object.freeze({ name: "terminal_resize_reflow", maturity: "removed" as const }),
    Object.freeze({
      name: "tool_search_always_defer_mcp_tools",
      maturity: "removed" as const,
    }),
    Object.freeze({ name: "tui_app_server", maturity: "removed" as const }),
  ]),
  ignoreUserConfig: true,
  ignoreRules: true,
  ephemeral: true,
  strictConfig: true,
});

export function executionPolicyHealth() {
  return {
    backend: CODEX_EXECUTION_POLICY.backend,
    permissionProfile: CODEX_EXECUTION_POLICY.permissionProfile,
    approvalPolicy: CODEX_EXECUTION_POLICY.approvalPolicy,
    mcpServers: CODEX_EXECUTION_POLICY.mcpServers,
    defaultWebSearch: CODEX_EXECUTION_POLICY.defaultWebSearch,
    disabledFeatures: [...CODEX_EXECUTION_POLICY.disabledFeatures],
    requiredFeatures: CODEX_EXECUTION_POLICY.requiredFeatures.map(
      (feature) => ({ ...feature }),
    ),
    ignoreUserConfig: CODEX_EXECUTION_POLICY.ignoreUserConfig,
    ignoreRules: CODEX_EXECUTION_POLICY.ignoreRules,
    ephemeral: CODEX_EXECUTION_POLICY.ephemeral,
    strictConfig: CODEX_EXECUTION_POLICY.strictConfig,
  };
}

export function assertSafeExecutionConfig(
  config: Pick<AppConfig, "codexWorkspace" | "codexHome">,
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

  const codexHome = config.codexHome.trim();
  if (!codexHome || !isAbsolute(codexHome)) {
    throw new Error("CODEX_HOME must be an absolute path.");
  }

  const resolvedCodexHome = resolve(codexHome);
  if (pathKey(resolvedCodexHome) === pathKey(parse(resolvedCodexHome).root)) {
    throw new Error("CODEX_HOME must not be a filesystem root.");
  }

  if (
    [process.cwd(), CODEXAPI_CHECKOUT].some((protectedPath) =>
      pathsOverlap(resolvedCodexHome, protectedPath),
    )
  ) {
    throw new Error(
      "CODEX_HOME must be outside source and current working directories.",
    );
  }

  let codexHomeStat;
  try {
    codexHomeStat = lstatSync(resolvedCodexHome);
  } catch {
    throw new Error("CODEX_HOME must exist as a directory.");
  }

  if (codexHomeStat.isSymbolicLink()) {
    throw new Error("CODEX_HOME must not be a symbolic link or reparse point.");
  }

  if (!codexHomeStat.isDirectory()) {
    throw new Error("CODEX_HOME must exist as a directory.");
  }

  let canonicalCodexHome;
  try {
    canonicalCodexHome = realpathSync.native(resolvedCodexHome);
  } catch {
    throw new Error("CODEX_HOME must exist as a directory.");
  }

  if (pathKey(canonicalCodexHome) !== pathKey(resolvedCodexHome)) {
    throw new Error("CODEX_HOME must not be a symbolic link or reparse point.");
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
