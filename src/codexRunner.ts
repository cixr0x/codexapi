import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CODEX_EXECUTION_POLICY } from "./executionPolicy.js";

export type CodexRunnerErrorCode =
  | "NON_ZERO_EXIT"
  | "SPAWN_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "TERMINATION_FAILED"
  | "INVALID_OUTPUT";

export class CodexRunnerError extends Error {
  readonly code: CodexRunnerErrorCode;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly command?: CodexCommandDetails;
  readonly childMayBeRunning: boolean;
  readonly cleanupWhenSafe?: Promise<void>;

  constructor({
    message,
    code,
    exitCode,
    stdout,
    stderr,
    command,
    childMayBeRunning = false,
    cleanupWhenSafe,
  }: {
    message: string;
    code: CodexRunnerErrorCode;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    command?: CodexCommandDetails;
    childMayBeRunning?: boolean;
    cleanupWhenSafe?: Promise<void>;
  }) {
    super(message);
    this.name = "CodexRunnerError";
    this.code = code;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.command = command;
    this.childMayBeRunning = childMayBeRunning;
    this.cleanupWhenSafe = cleanupWhenSafe;
  }
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CodexRunnerConfig {
  command: string;
  commandArgs?: string[];
  workspace: string;
  codexHome: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  forceTerminationGraceMs?: number;
  spawn?: SpawnFn;
}

export interface CodexRunOptions {
  model?: string;
  reasoningEffort?: string;
  outputSchema?: unknown;
  webSearch?: boolean;
  imagePaths?: readonly string[];
  signal?: AbortSignal;
}

export interface CodexCommandDetails {
  executable: string;
  args: string[];
  cwd: string;
  shell: false;
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexRunResult {
  stdout: string;
  rawStdout?: string;
  stderr: string;
  usage?: CodexUsage;
  command?: CodexCommandDetails;
}

export interface CodexRunner {
  run(prompt: string): Promise<string>;
  runWithDetails?: (prompt: string, options?: CodexRunOptions) => Promise<CodexRunResult>;
}

interface ParsedCodexOutput {
  output: string;
  usage?: CodexUsage;
}

export function createCodexRunner(config: CodexRunnerConfig): CodexRunner {
  return {
    async run(prompt: string) {
      const result = await runCodexPromptWithDetails(prompt, config);
      return result.stdout;
    },
    runWithDetails(prompt: string, options?: CodexRunOptions) {
      return runCodexPromptWithDetails(prompt, config, options);
    },
  };
}

export function runCodexPrompt(
  prompt: string,
  config: CodexRunnerConfig,
): Promise<string> {
  return runCodexPromptWithDetails(prompt, config).then((result) => result.stdout);
}

export function runCodexPromptWithDetails(
  prompt: string,
  config: CodexRunnerConfig,
  options: CodexRunOptions = {},
): Promise<CodexRunResult> {
  if (options.signal?.aborted) {
    return Promise.reject(cancelledRunnerError());
  }
  if (options.outputSchema === undefined) {
    return runCodexProcess(prompt, config, options);
  }

  return runCodexWithOutputSchema(prompt, config, options);
}

async function runCodexWithOutputSchema(
  prompt: string,
  config: CodexRunnerConfig,
  options: CodexRunOptions,
): Promise<CodexRunResult> {
  const schemaDir = await mkdtemp(join(tmpdir(), "codexapi-output-schema-"));
  const schemaPath = join(schemaDir, "schema.json");
  let cleanupSafe = true;

  try {
    await writeFile(schemaPath, JSON.stringify(options.outputSchema), "utf8");
    return await runCodexProcess(prompt, config, options, schemaPath);
  } catch (error) {
    if (error instanceof CodexRunnerError && error.childMayBeRunning) {
      cleanupSafe = false;
      if (error.cleanupWhenSafe) {
        cleanupAfterSafeSignal(error.cleanupWhenSafe, () =>
          rm(schemaDir, { recursive: true, force: true }),
        );
      }
    }
    throw error;
  } finally {
    if (cleanupSafe) {
      await rm(schemaDir, { recursive: true, force: true });
    }
  }
}

function runCodexProcess(
  prompt: string,
  {
    command,
    commandArgs = [],
    workspace,
    codexHome,
    timeoutMs,
    maxOutputBytes = 1024 * 1024,
    terminationGraceMs = 1000,
    forceTerminationGraceMs = 1000,
    spawn = nodeSpawn,
  }: CodexRunnerConfig,
  options: CodexRunOptions,
  outputSchemaPath?: string,
): Promise<CodexRunResult> {
  if (options.signal?.aborted) {
    return Promise.reject(cancelledRunnerError());
  }

  const model = normalizeStringOption(options.model);
  const reasoningEffort = normalizeStringOption(options.reasoningEffort);
  const imagePaths = options.imagePaths ?? [];
  const args = [
    ...commandArgs,
    "exec",
    "-",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    CODEX_EXECUTION_POLICY.sandbox,
    "-c",
    `approval_policy=${tomlString(CODEX_EXECUTION_POLICY.approvalPolicy)}`,
    "-c",
    "mcp_servers={}",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--strict-config",
    ...CODEX_EXECUTION_POLICY.disabledFeatures.flatMap((name) => ["--disable", name]),
    "-c",
    `web_search=${options.webSearch ? '"live"' : '"disabled"'}`,
    ...(options.webSearch ? ["-c", "tools.web_search=true"] : []),
    ...imagePaths.flatMap((path) => ["--image", path]),
    ...(model ? ["--model", model] : []),
    ...(reasoningEffort
      ? ["-c", `model_reasoning_effort=${tomlString(reasoningEffort)}`]
      : []),
    ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
  ];
  const commandDetails: CodexCommandDetails = {
    executable: command,
    args,
    cwd: workspace,
    shell: false,
  };

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let fatalSettlement = false;
    let termination: "TIMEOUT" | "CANCELLED" | undefined;
    let terminationGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTerminationGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveCleanupWhenSafe!: () => void;
    const cleanupWhenSafe = new Promise<void>((resolveCleanup) => {
      resolveCleanupWhenSafe = resolveCleanup;
    });

    const child = spawn(command, args, {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: createCodexChildEnvironment(codexHome),
    });
    const onStdout = (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes);
    };
    const onChildError = (error: Error) => {
      if (termination) {
        return;
      }
      settle(() => {
        reject(
          new CodexRunnerError({
            message: `Failed to start Codex command: ${error.message}`,
            code: "SPAWN_ERROR",
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            command: commandDetails,
          }),
        );
      });
    };
    const settleAfterVerifiedTermination = () => {
      settle(() => {
        const rawStdout = stdout.trimEnd();
        const finalStderr = stderr.trimEnd();

        if (termination === "CANCELLED") {
          reject(
            cancelledRunnerError({
              stdout: rawStdout,
              stderr: finalStderr,
              command: commandDetails,
            }),
          );
          return;
        }

        reject(
          new CodexRunnerError({
            message: `Codex command timed out after ${timeoutMs} ms.`,
            code: "TIMEOUT",
            stdout: rawStdout,
            stderr: finalStderr,
            command: commandDetails,
          }),
        );
      });
    };
    const onChildClose = (code: number | null) => {
      if (fatalSettlement) {
        removeChildListeners();
        resolveCleanupWhenSafe();
        return;
      }

      if (termination) {
        settleAfterVerifiedTermination();
        return;
      }

      settle(() => {
        const rawStdout = stdout.trimEnd();
        const finalStderr = stderr.trimEnd();

        if (code !== 0) {
          reject(
            new CodexRunnerError({
              message: `Codex command exited with code ${code ?? "unknown"}.`,
              code: "NON_ZERO_EXIT",
              exitCode: code,
              stdout: rawStdout,
              stderr: finalStderr,
              command: commandDetails,
            }),
          );
          return;
        }

        try {
          const parsed = parseCodexOutput(rawStdout);
          resolve({
            stdout: parsed.output,
            rawStdout,
            stderr: finalStderr,
            usage: parsed.usage,
            command: commandDetails,
          });
        } catch (error) {
          reject(
            new CodexRunnerError({
              message:
                error instanceof Error
                  ? error.message
                  : "Codex returned invalid JSONL output.",
              code: "INVALID_OUTPUT",
              stdout: rawStdout,
              stderr: finalStderr,
              command: commandDetails,
            }),
          );
        }
      });
    };
    const requestTermination = (reason: "TIMEOUT" | "CANCELLED") => {
      if (settled || termination) {
        return;
      }
      termination = reason;
      clearTimeout(timeout);
      terminationGraceTimer = setTimeout(
        forceTerminate,
        terminationGraceMs,
      );
      tryKill(child, "SIGTERM");
    };
    const forceTerminate = () => {
      if (settled || !termination) {
        return;
      }

      forceTerminationGraceTimer = setTimeout(
        failUnverifiedTermination,
        forceTerminationGraceMs,
      );
      tryKill(child, "SIGKILL");
    };
    const failUnverifiedTermination = () => {
      if (settled || !termination) {
        return;
      }

      settle(() => {
        reject(
          new CodexRunnerError({
            message: "Codex process could not be terminated.",
            code: "TERMINATION_FAILED",
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            command: commandDetails,
            childMayBeRunning: true,
            cleanupWhenSafe,
          }),
        );
      }, true);
    };
    const onAbort = () => requestTermination("CANCELLED");
    const timeout = setTimeout(() => requestTermination("TIMEOUT"), timeoutMs);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onChildError);
    child.on("close", onChildClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.signal?.aborted) {
      onAbort();
    } else {
      child.stdin?.write(prompt);
      child.stdin?.end();
    }

    function settle(action: () => void, retainChildListeners = false): void {
      if (settled) {
        return;
      }

      settled = true;
      fatalSettlement = retainChildListeners;
      clearRequestLifecycle();
      if (!retainChildListeners) {
        removeChildListeners();
      }
      action();
    }

    function clearRequestLifecycle(): void {
      clearTimeout(timeout);
      if (terminationGraceTimer !== undefined) {
        clearTimeout(terminationGraceTimer);
      }
      if (forceTerminationGraceTimer !== undefined) {
        clearTimeout(forceTerminationGraceTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    }

    function removeChildListeners(): void {
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onChildError);
      child.removeListener("close", onChildClose);
    }
  });
}

function cleanupAfterSafeSignal(
  cleanupWhenSafe: Promise<void>,
  cleanup: () => Promise<void>,
): void {
  void cleanupWhenSafe.then(cleanup).catch(() => undefined);
}

function tryKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Failure to signal is handled by escalation and the bounded fatal fallback.
  }
}

function cancelledRunnerError({
  stdout,
  stderr,
  command,
}: {
  stdout?: string;
  stderr?: string;
  command?: CodexCommandDetails;
} = {}): CodexRunnerError {
  return new CodexRunnerError({
    message: "Codex command was cancelled.",
    code: "CANCELLED",
    stdout,
    stderr,
    command,
  });
}

const CODEX_CHILD_ENV_ALLOWLIST = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "OPENAI_API_KEY",
] as const;

export function createCodexChildEnvironment(
  codexHome: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    HOME: codexHome,
    USERPROFILE: codexHome,
  };
  const sourceKeys = new Map(
    Object.keys(source).map((key) => [key.toLowerCase(), key]),
  );

  for (const name of CODEX_CHILD_ENV_ALLOWLIST) {
    const sourceKey = sourceKeys.get(name.toLowerCase());
    const value = sourceKey === undefined ? undefined : source[sourceKey];
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

function parseCodexOutput(rawStdout: string): ParsedCodexOutput {
  const messages: string[] = [];
  let usage: CodexUsage | undefined;
  let sawJsonlEvent = false;

  for (const line of rawStdout.split(/\r?\n/)) {
    const event = parseRecord(line);
    if (!event || typeof event.type !== "string") {
      continue;
    }

    sawJsonlEvent = true;
    if (event.type === "item.completed") {
      const item = isRecord(event.item) ? event.item : undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        messages.push(item.text);
      }
      continue;
    }

    if (event.type === "turn.completed" && isRecord(event.usage)) {
      usage = {
        inputTokens: readTokenCount(event.usage.input_tokens),
        cachedInputTokens: readTokenCount(event.usage.cached_input_tokens),
        outputTokens: readTokenCount(event.usage.output_tokens),
        reasoningOutputTokens: readTokenCount(event.usage.reasoning_output_tokens),
      };
    }
  }

  if (!sawJsonlEvent) {
    return { output: rawStdout };
  }

  const output = messages.at(-1);
  if (output === undefined) {
    throw new Error("Codex JSONL output did not contain a completed agent message.");
  }

  return { output: output.trimEnd(), usage };
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringOption(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function appendBounded(
  current: string,
  chunk: Buffer | string,
  maxOutputBytes: number,
): string {
  if (Buffer.byteLength(current, "utf8") >= maxOutputBytes) {
    return current;
  }

  const next = current + chunk.toString();
  if (Buffer.byteLength(next, "utf8") <= maxOutputBytes) {
    return next;
  }

  return next.slice(0, maxOutputBytes);
}
