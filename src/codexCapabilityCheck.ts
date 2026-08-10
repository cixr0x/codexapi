import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { defaultCodexCommand, type AppConfig } from "./config.js";
import { createCodexChildEnvironment, type SpawnFn } from "./codexRunner.js";
import { CODEX_EXECUTION_POLICY } from "./executionPolicy.js";

const MINIMUM_CODEX_VERSION = [0, 144, 1] as const;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const MAX_PROBE_TIMEOUT_MS = 10_000;
const PROBE_TERMINATION_GRACE_MS = 1_000;

export const CODEX_CAPABILITY_POLICY_NAME = "codexapi-constrained-v1";

export interface CodexCapabilityReport {
  version: string;
  shellToolFeature: "stable" | "experimental";
  checked: true;
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

  if (!isMinimumVersion(version)) {
    throw new Error("CodexAPI requires Codex CLI 0.144.1 or newer.");
  }

  const featureOutput = await runProbe(
    command.command,
    [...command.args, ...capabilityPolicyArgs(), "features", "list"],
    config,
    "feature",
    spawn,
  );
  const shellToolFeature = parseDisabledFeatureOutput(featureOutput.stdout);

  const mcpOutput = await runProbe(
    command.command,
    [...command.args, ...capabilityPolicyArgs(), "mcp", "list", "--json"],
    config,
    "MCP inventory",
    spawn,
  );
  assertEmptyMcpInventory(mcpOutput.stdout);

  return { version: version.text, shellToolFeature, checked: true };
}

function capabilityPolicyArgs(): string[] {
  return [
    "-c",
    `approval_policy=${tomlString(CODEX_EXECUTION_POLICY.approvalPolicy)}`,
    "-c",
    "mcp_servers={}",
    ...CODEX_EXECUTION_POLICY.disabledFeatures.flatMap((feature) => [
      "--disable",
      feature,
    ]),
    "-c",
    'web_search="disabled"',
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

function isMinimumVersion(version: { parts: [number, number, number] }): boolean {
  for (let index = 0; index < MINIMUM_CODEX_VERSION.length; index += 1) {
    const minimum = MINIMUM_CODEX_VERSION[index]!;
    const actual = version.parts[index]!;
    if (actual !== minimum) {
      return actual > minimum;
    }
  }

  return true;
}

function parseDisabledFeatureOutput(output: string): "stable" | "experimental" {
  const lines = output.split(/\r?\n/).map((candidate) => candidate.trim());
  const recognizedMaturities = new Set([
    "stable",
    "experimental",
    "under development",
  ]);
  let shellToolFeature: "stable" | "experimental" | undefined;

  for (const expectedName of CODEX_EXECUTION_POLICY.disabledFeatures) {
    const candidates = lines.filter(
      (line) => line.split(/\s+/, 1)[0] === expectedName,
    );
    if (candidates.length === 0) {
      throw new Error(`Codex ${expectedName} feature was not reported.`);
    }
    if (candidates.length !== 1) {
      throw new Error(`Codex ${expectedName} feature is incompatible with this policy.`);
    }

    const match = /^(\S+)\s+(.+?)\s+(true|false)$/.exec(candidates[0]!);
    if (!match || match[1] !== expectedName) {
      throw new Error(`Codex ${expectedName} feature is incompatible with this policy.`);
    }
    if (!recognizedMaturities.has(match[2]!)) {
      throw new Error(`Codex ${expectedName} feature is incompatible with this policy.`);
    }
    if (match[3] === "true") {
      throw new Error(
        `Codex ${expectedName} feature is enabled despite the disable policy.`,
      );
    }

    if (expectedName === "shell_tool") {
      if (match[2] !== "stable" && match[2] !== "experimental") {
        throw new Error("Codex shell_tool feature is incompatible with this policy.");
      }
      shellToolFeature = match[2];
    }
  }

  if (shellToolFeature === undefined) {
    throw new Error("Codex shell_tool feature was not reported.");
  }
  return shellToolFeature;
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
