import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { defaultCodexCommand, type AppConfig } from "./config.js";
import { createCodexChildEnvironment, type SpawnFn } from "./codexRunner.js";
import { CODEX_EXECUTION_POLICY } from "./executionPolicy.js";

const PINNED_CODEX_VERSION = [0, 147, 0] as const;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const MAX_PROBE_TIMEOUT_MS = 10_000;
const PROBE_TERMINATION_GRACE_MS = 1_000;

export const CODEX_CAPABILITY_POLICY_NAME = "codexapi-capable-isolated-v2";

export interface CodexCapabilityReport {
  version: string;
  requiredFeatures: string[];
  disabledFeatures: string[];
  permissionProfile: string;
  webSearch: "live";
  checked: true;
}

interface CodexFeatureState {
  maturity: string;
  enabled: boolean;
}

export class CodexCapabilityProbeError extends Error {
  readonly code: "TIMEOUT" | "TERMINATION_FAILED";
  readonly childMayBeRunning: boolean;

  constructor({
    message,
    code,
    childMayBeRunning = false,
  }: {
    message: string;
    code: "TIMEOUT" | "TERMINATION_FAILED";
    childMayBeRunning?: boolean;
  }) {
    super(message);
    this.name = "CodexCapabilityProbeError";
    this.code = code;
    this.childMayBeRunning = childMayBeRunning;
  }
}

export async function assertCodexCapabilities(
  config: Pick<AppConfig, "codexWorkspace" | "codexHome" | "codexTimeoutMs">,
  spawn: SpawnFn = nodeSpawn,
): Promise<CodexCapabilityReport> {
  const command = defaultCodexCommand();
  const versionOutput = await runProbe(
    command.command,
    [...command.args, "--version"],
    config,
    "version",
    spawn,
  );
  const version = parseCodexVersion(versionOutput.stdout);

  if (!isPinnedVersion(version)) {
    throw new Error("CodexAPI requires exact Codex CLI 0.147.0.");
  }

  const featureOutput = await runProbe(
    command.command,
    [...command.args, ...featurePolicyArgs(), "features", "list"],
    config,
    "feature",
    spawn,
  );
  assertFeatureOutput(featureOutput.stdout);

  const mcpOutput = await runProbe(
    command.command,
    [...command.args, ...profileCompatibilityArgs(), "mcp", "list", "--json"],
    config,
    "MCP inventory",
    spawn,
  );
  assertEmptyMcpInventory(mcpOutput.stdout);

  return {
    version: version.text,
    requiredFeatures: CODEX_EXECUTION_POLICY.requiredFeatures.map(({ name }) => name),
    disabledFeatures: [...CODEX_EXECUTION_POLICY.disabledFeatures],
    permissionProfile: CODEX_EXECUTION_POLICY.permissionProfile,
    webSearch: "live",
    checked: true,
  };
}

function featurePolicyArgs(): string[] {
  return [
    "-c",
    `approval_policy=${tomlString(CODEX_EXECUTION_POLICY.approvalPolicy)}`,
    "-c",
    "mcp_servers={}",
    ...CODEX_EXECUTION_POLICY.requiredFeatures.flatMap(({ name }) => [
      "--enable",
      name,
    ]),
    ...CODEX_EXECUTION_POLICY.disabledFeatures.flatMap((feature) => [
      "--disable",
      feature,
    ]),
    "-c",
    'web_search="live"',
    "-c",
    "tools.web_search=true",
  ];
}

function profileCompatibilityArgs(): string[] {
  return [
    "--profile",
    CODEX_EXECUTION_POLICY.permissionProfile,
    ...featurePolicyArgs(),
  ];
}

function runProbe(
  command: string,
  args: string[],
  config: Pick<AppConfig, "codexWorkspace" | "codexHome" | "codexTimeoutMs">,
  name: string,
  spawn: SpawnFn,
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = Math.min(Math.max(1, config.codexTimeoutMs), MAX_PROBE_TIMEOUT_MS);
  const options: SpawnOptions = {
    cwd: config.codexWorkspace,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: createCodexChildEnvironment(config.codexHome),
  };

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let fatalSettlement = false;
    let terminationGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTerminationGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    let terminating = false;
    let outputExceeded = false;

    const onStdout = (chunk: Buffer | string) => {
      const appended = appendBounded(stdout, chunk);
      stdout = appended.value;
      outputExceeded ||= appended.exceeded;
    };
    const onStderr = (chunk: Buffer | string) => {
      const appended = appendBounded(stderr, chunk);
      stderr = appended.value;
      outputExceeded ||= appended.exceeded;
    };
    const onError = (error: Error) => {
      if (terminating) {
        return;
      }
      settle(() => reject(new Error(`Codex ${name} probe could not start: ${error.message}.`)));
    };
    const onClose = (code: number | null) => {
      if (fatalSettlement) {
        removeChildListeners();
        return;
      }

      if (terminating) {
        settle(() => {
          reject(
            new CodexCapabilityProbeError({
              message: `Codex ${name} probe timed out after ${timeoutMs} ms.`,
              code: "TIMEOUT",
            }),
          );
        });
        return;
      }

      settle(() => {
        if (outputExceeded) {
          reject(
            new Error(
              `Codex ${name} probe output exceeded ${MAX_PROBE_OUTPUT_BYTES} bytes.`,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(new Error(`Codex ${name} probe exited with code ${code ?? "unknown"}.`));
          return;
        }
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
      });
    };

    const requestTermination = () => {
      if (settled || terminating || !child) {
        return;
      }
      terminating = true;
      clearTimeout(timeout);
      terminationGraceTimer = setTimeout(forceTerminate, PROBE_TERMINATION_GRACE_MS);
      tryKill(child, "SIGTERM");
    };
    const forceTerminate = () => {
      if (settled || !terminating || !child) {
        return;
      }
      forceTerminationGraceTimer = setTimeout(
        failUnverifiedTermination,
        PROBE_TERMINATION_GRACE_MS,
      );
      tryKill(child, "SIGKILL");
    };
    const failUnverifiedTermination = () => {
      if (settled || !terminating) {
        return;
      }
      settle(
        () => {
          reject(
            new CodexCapabilityProbeError({
              message: `Codex ${name} probe could not be terminated.`,
              code: "TERMINATION_FAILED",
              childMayBeRunning: true,
            }),
          );
        },
        true,
      );
    };

    try {
      child = spawn(command, args, options);
    } catch (error) {
      reject(
        new Error(
          `Codex ${name} probe could not start: ${error instanceof Error ? error.message : "unknown error"}.`,
        ),
      );
      return;
    }

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    timeout = setTimeout(requestTermination, timeoutMs);

    function settle(action: () => void, retainChildReaper = false): void {
      if (settled) {
        return;
      }
      settled = true;
      fatalSettlement = retainChildReaper;
      clearProbeLifecycle();
      if (retainChildReaper) {
        child?.stdout?.removeListener("data", onStdout);
        child?.stderr?.removeListener("data", onStderr);
      } else {
        removeChildListeners();
      }
      action();
    }

    function clearProbeLifecycle(): void {
      clearTimeout(timeout);
      if (terminationGraceTimer !== undefined) {
        clearTimeout(terminationGraceTimer);
      }
      if (forceTerminationGraceTimer !== undefined) {
        clearTimeout(forceTerminationGraceTimer);
      }
    }

    function removeChildListeners(): void {
      child?.stdout?.removeListener("data", onStdout);
      child?.stderr?.removeListener("data", onStderr);
      child?.removeListener("error", onError);
      child?.removeListener("close", onClose);
    }
  });
}

function parseCodexVersion(output: string): { text: string; parts: [number, number, number] } {
  const match = /^codex-cli ((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))$/.exec(output);
  if (!match) {
    throw new Error("Codex version output was not recognized.");
  }

  const parts: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (!parts.every((part) => Number.isSafeInteger(part) && part >= 0)) {
    throw new Error("Codex version output was not recognized.");
  }

  return {
    text: `${match[1]}.${match[2]}.${match[3]}`,
    parts,
  };
}

function isPinnedVersion(version: { parts: [number, number, number] }): boolean {
  return PINNED_CODEX_VERSION.every(
    (expected, index) => version.parts[index] === expected,
  );
}

function assertFeatureOutput(output: string): void {
  const lines = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const features = new Map<string, CodexFeatureState>();

  for (const line of lines) {
    const match = /^([a-z][a-z0-9_]*)\s+(.+?)\s+(true|false)$/.exec(line);
    if (!match) {
      throw new Error("Codex feature output contained a malformed row.");
    }

    const [, name, maturity, enabledText] = match;
    if (features.has(name!)) {
      throw new Error(`Codex ${name} feature is incompatible with this policy.`);
    }
    const enabled = enabledText === "true";
    features.set(name!, { maturity: maturity!, enabled });
  }

  for (const name of CODEX_EXECUTION_POLICY.disabledFeatures) {
    const feature = features.get(name);
    if (!feature) {
      throw new Error(`Codex ${name} feature was not reported.`);
    }
    if (feature.enabled) {
      throw new Error(
        `Codex ${name} feature is enabled despite the disable policy.`,
      );
    }
  }

  for (const expected of CODEX_EXECUTION_POLICY.requiredFeatures) {
    const feature = features.get(expected.name);
    if (!feature) {
      throw new Error(`Codex ${expected.name} feature was not reported.`);
    }
    if (
      !feature.enabled ||
      feature.maturity !== expected.maturity
    ) {
      throw new Error(`Codex ${expected.name} feature is incompatible with this policy.`);
    }
  }
}

function tryKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The bounded escalation path remains authoritative if a signal cannot be sent.
  }
}

function assertEmptyMcpInventory(output: string): void {
  try {
    const inventory = JSON.parse(output) as unknown;
    if (Array.isArray(inventory) && inventory.length === 0) {
      return;
    }
  } catch {
    // The generic fail-closed message below intentionally does not include raw CLI output.
  }

  throw new Error("Codex MCP inventory is not empty or was not recognized.");
}

function appendBounded(
  current: string,
  chunk: Buffer | string,
): { value: string; exceeded: boolean } {
  const remainingBytes = MAX_PROBE_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
  const sourceBytes = Buffer.isBuffer(chunk)
    ? chunk.byteLength
    : Buffer.byteLength(chunk, "utf8");
  if (sourceBytes > remainingBytes) {
    return { value: current, exceeded: true };
  }

  const text = chunk.toString();
  if (Buffer.byteLength(text, "utf8") > remainingBytes) {
    return { value: current, exceeded: true };
  }

  return { value: current + text, exceeded: false };
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
