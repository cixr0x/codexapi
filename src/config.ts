import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";

import { assertSafeExecutionConfig } from "./executionPolicy.js";

export type CodexBackend = "exec";
export const CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export interface AppConfig {
  host: string;
  port: number;
  codexBackend: CodexBackend;
  codexWorkspace: string;
  codexHome: string;
  codexTimeoutMs: number;
  codexDefaultModel: string;
  codexAllowedModels: string[];
  codexReasoningEffort: CodexReasoningEffort;
  callLoggingEnabled: boolean;
  callLogDir: string;
}

export interface CodexCommandDefault {
  command: string;
  args: string[];
}

const PINNED_CODEX_VERSION = "0.144.1";
const requireFromHere = createRequire(import.meta.url);

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform = process.platform,
): AppConfig {
  const config: AppConfig = {
    host: env.HOST ?? "127.0.0.1",
    port: parseInteger(env.PORT, 3001, "PORT"),
    codexBackend: parseCodexBackend(env.CODEX_BACKEND),
    codexWorkspace: env.CODEX_WORKSPACE ?? "",
    codexHome: env.CODEX_HOME ?? "",
    codexTimeoutMs: parseInteger(env.CODEX_TIMEOUT_MS, 120000, "CODEX_TIMEOUT_MS"),
    codexDefaultModel: parseString(env.CODEX_DEFAULT_MODEL, "gpt-5.4-mini"),
    codexAllowedModels: parseList(env.CODEX_ALLOWED_MODELS, [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]),
    codexReasoningEffort: parseCodexReasoningEffort(env.CODEX_REASONING_EFFORT),
    callLoggingEnabled: parseBoolean(env.CODEX_CALL_LOGGING, false),
    callLogDir: env.CODEX_CALL_LOG_DIR ?? join(cwd, ".codexapi", "logs"),
  };

  assertSafeExecutionConfig(config);
  return config;
}

export function defaultCodexCommand(): CodexCommandDefault {
  const packageJsonPath = realpathSync.native(
    requireFromHere.resolve("@openai/codex/package.json"),
  );
  const packageRoot = dirname(packageJsonPath);
  const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
  };
  if (metadata.version !== PINNED_CODEX_VERSION) {
    throw new Error(
      `Installed @openai/codex version must be exactly ${PINNED_CODEX_VERSION}.`,
    );
  }

  const scriptPath = realpathSync.native(join(packageRoot, "bin", "codex.js"));
  const scriptRelation = relative(packageRoot, scriptPath);
  if (
    !isAbsolute(scriptPath) ||
    /^\.\.(?:[\\/]|$)/.test(scriptRelation) ||
    isAbsolute(scriptRelation)
  ) {
    throw new Error("Resolved Codex script must stay inside the pinned package.");
  }

  const command = realpathSync.native(process.execPath);
  if (!isAbsolute(command)) {
    throw new Error("Node executable path must be absolute.");
  }

  return { command, args: [scriptPath] };
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  options: { allowZero?: boolean } = {},
): number {
  if (value == null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  const tooSmall = options.allowZero ? parsed < 0 : parsed <= 0;
  if (!Number.isFinite(parsed) || tooSmall) {
    throw new Error(
      options.allowZero
        ? `${name} must be a non-negative integer.`
        : `${name} must be a positive integer.`,
    );
  }

  return parsed;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value == null || value === "") {
    return fallback;
  }

  const parsed = value
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);

  return parsed.length ? parsed : fallback;
}

function parseString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseCodexBackend(value: string | undefined): CodexBackend {
  if (value == null || value === "" || value === "exec") {
    return "exec";
  }

  throw new Error("CODEX_BACKEND only supports exec.");
}

function parseCodexReasoningEffort(value: string | undefined): CodexReasoningEffort {
  if (value == null || value === "") {
    return "medium";
  }

  if (isCodexReasoningEffort(value)) {
    return value;
  }

  throw new Error(
    `CODEX_REASONING_EFFORT must be one of: ${CODEX_REASONING_EFFORTS.join(", ")}.`,
  );
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return (
    typeof value === "string" &&
    CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort)
  );
}
