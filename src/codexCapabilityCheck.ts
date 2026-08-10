import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { defaultCodexCommand, type AppConfig } from "./config.js";
import { createCodexChildEnvironment, type SpawnFn } from "./codexRunner.js";
import { CODEX_EXECUTION_POLICY } from "./executionPolicy.js";

const MINIMUM_CODEX_VERSION = [0, 144, 1] as const;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const MAX_PROBE_TIMEOUT_MS = 10_000;

export const CODEX_CAPABILITY_POLICY_NAME = "codexapi-constrained-v1";

export interface CodexCapabilityReport {
  version: string;
  shellToolFeature: "stable" | "experimental";
  checked: true;
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
  const shellToolFeature = parseShellToolFeature(featureOutput.stdout);

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
    "--strict-config",
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
    let child: ChildProcess;
    const timeout = setTimeout(() => {
      settle(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The bounded timeout remains authoritative if the child cannot be signaled.
        }
        reject(new Error(`Codex ${name} probe timed out after ${timeoutMs} ms.`));
      });
    }, timeoutMs);

    try {
      child = spawn(command, args, options);
    } catch (error) {
      settle(() => {
        reject(
          new Error(
            `Codex ${name} probe could not start: ${error instanceof Error ? error.message : "unknown error"}.`,
          ),
        );
      });
      return;
    }

    const onStdout = (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk);
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk);
    };
    const onError = (error: Error) => {
      settle(() => reject(new Error(`Codex ${name} probe could not start: ${error.message}.`)));
    };
    const onClose = (code: number | null) => {
      settle(() => {
        if (code !== 0) {
          reject(new Error(`Codex ${name} probe exited with code ${code ?? "unknown"}.`));
          return;
        }
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
      });
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);

    function settle(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child?.stdout?.removeListener("data", onStdout);
      child?.stderr?.removeListener("data", onStderr);
      child?.removeListener("error", onError);
      child?.removeListener("close", onClose);
      action();
    }
  });
}

function parseCodexVersion(output: string): { text: string; parts: [number, number, number] } {
  const match = /\bcodex-cli\s+(\d+)\.(\d+)\.(\d+)(?![-+])/i.exec(output);
  if (!match) {
    throw new Error("Codex version output was not recognized.");
  }

  return {
    text: `${match[1]}.${match[2]}.${match[3]}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
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

function parseShellToolFeature(output: string): "stable" | "experimental" {
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim().split(/\s+/))
    .find(([name]) => name === "shell_tool");
  if (!line) {
    throw new Error("Codex shell_tool feature was not reported.");
  }

  const feature = line[1];
  if (feature === "stable" || feature === "experimental") {
    return feature;
  }

  throw new Error("Codex shell_tool feature is incompatible with this policy.");
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

function appendBounded(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current, "utf8") >= MAX_PROBE_OUTPUT_BYTES) {
    return current;
  }

  const next = current + chunk.toString();
  if (Buffer.byteLength(next, "utf8") <= MAX_PROBE_OUTPUT_BYTES) {
    return next;
  }

  return next.slice(0, MAX_PROBE_OUTPUT_BYTES);
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
