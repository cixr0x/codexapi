import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";

import { assertSafeExecutionConfig } from "./executionPolicy.js";

export type CodexBackend = "exec";
export const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
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

const PINNED_CODEX_VERSION = "0.147.0";
export const CODEXAPI_FIXED_HOST = "127.0.0.1";
export const CODEXAPI_FIXED_PORT = 3001;
const requireFromHere = createRequire(import.meta.url);

interface NativeCodexTarget {
  packageName: string;
  targetTriple: string;
  versionSuffix: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform = process.platform,
): AppConfig {
  const config: AppConfig = {
    host: env.HOST ?? CODEXAPI_FIXED_HOST,
    port: parseFixedPort(env.PORT),
    codexBackend: parseCodexBackend(env.CODEX_BACKEND),
    codexWorkspace: env.CODEX_WORKSPACE ?? "",
    codexHome: env.CODEX_HOME ?? "",
    codexTimeoutMs: parseInteger(
      env.CODEX_TIMEOUT_MS,
      DEFAULT_CODEX_TIMEOUT_MS,
      "CODEX_TIMEOUT_MS",
    ),
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

  assertFixedListenerConfig(config);
  assertSafeExecutionConfig(config);
  return config;
}

export function defaultCodexCommand(): CodexCommandDefault {
  const packageJsonPath = realpathSync.native(
    requireFromHere.resolve("@openai/codex/package.json"),
  );
  const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    version?: string;
    optionalDependencies?: Record<string, string>;
  };
  if (
    metadata.name !== "@openai/codex" ||
    metadata.version !== PINNED_CODEX_VERSION
  ) {
    throw new Error(
      `Installed @openai/codex version must be exactly ${PINNED_CODEX_VERSION}.`,
    );
  }

  const target = nativeCodexTarget(process.platform, process.arch);
  const expectedDependency =
    `npm:@openai/codex@${PINNED_CODEX_VERSION}-${target.versionSuffix}`;
  if (metadata.optionalDependencies?.[target.packageName] !== expectedDependency) {
    throw new Error("Pinned Codex package has an unexpected native dependency.");
  }

  const requireFromPinnedPackage = createRequire(packageJsonPath);
  const nativePackageJsonPath = realpathSync.native(
    requireFromPinnedPackage.resolve(`${target.packageName}/package.json`),
  );
  const nativePackageRoot = dirname(nativePackageJsonPath);
  const nativeMetadata = JSON.parse(
    readFileSync(nativePackageJsonPath, "utf8"),
  ) as { name?: string; version?: string };
  if (
    nativeMetadata.name !== "@openai/codex" ||
    nativeMetadata.version !==
      `${PINNED_CODEX_VERSION}-${target.versionSuffix}`
  ) {
    throw new Error("Installed platform-native Codex package has an unexpected version.");
  }

  const command = realpathSync.native(
    join(
      nativePackageRoot,
      "vendor",
      target.targetTriple,
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    ),
  );
  assertContainedAbsolutePath(
    nativePackageRoot,
    command,
    "Resolved Codex executable must stay inside the pinned native package.",
  );

  return { command, args: [] };
}

export function assertFixedListenerConfig(
  config: Pick<AppConfig, "host" | "port">,
): void {
  if (config.host !== CODEXAPI_FIXED_HOST) {
    throw new Error(`HOST must be exactly ${CODEXAPI_FIXED_HOST}.`);
  }
  if (!Number.isInteger(config.port) || config.port !== CODEXAPI_FIXED_PORT) {
    throw new Error(`PORT must be exactly ${CODEXAPI_FIXED_PORT}.`);
  }
}

function nativeCodexTarget(
  platform: NodeJS.Platform,
  arch: string,
): NativeCodexTarget {
  const target = NATIVE_CODEX_TARGETS[`${platform}-${arch}`];
  if (!target) {
    throw new Error(`Unsupported Codex platform: ${platform}-${arch}.`);
  }
  return target;
}

const NATIVE_CODEX_TARGETS: Readonly<Record<string, NativeCodexTarget>> = {
  "linux-x64": {
    packageName: "@openai/codex-linux-x64",
    targetTriple: "x86_64-unknown-linux-musl",
    versionSuffix: "linux-x64",
  },
  "linux-arm64": {
    packageName: "@openai/codex-linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl",
    versionSuffix: "linux-arm64",
  },
  "darwin-x64": {
    packageName: "@openai/codex-darwin-x64",
    targetTriple: "x86_64-apple-darwin",
    versionSuffix: "darwin-x64",
  },
  "darwin-arm64": {
    packageName: "@openai/codex-darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
    versionSuffix: "darwin-arm64",
  },
  "win32-x64": {
    packageName: "@openai/codex-win32-x64",
    targetTriple: "x86_64-pc-windows-msvc",
    versionSuffix: "win32-x64",
  },
  "win32-arm64": {
    packageName: "@openai/codex-win32-arm64",
    targetTriple: "aarch64-pc-windows-msvc",
    versionSuffix: "win32-arm64",
  },
};

function assertContainedAbsolutePath(
  root: string,
  candidate: string,
  message: string,
): void {
  const relation = relative(root, candidate);
  if (
    !isAbsolute(candidate) ||
    /^\.\.(?:[\\/]|$)/.test(relation) ||
    isAbsolute(relation)
  ) {
    throw new Error(message);
  }
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

function parseFixedPort(value: string | undefined): number {
  if (value == null || value === "") {
    return CODEXAPI_FIXED_PORT;
  }
  if (value !== String(CODEXAPI_FIXED_PORT)) {
    throw new Error(`PORT must be exactly ${CODEXAPI_FIXED_PORT}.`);
  }
  return CODEXAPI_FIXED_PORT;
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
