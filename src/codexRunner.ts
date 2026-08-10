import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CODEX_EXECUTION_POLICY } from "./executionPolicy.js";

const CODE_MODE_DISABLED_WARNING =
  "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";

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

interface ParsedItemLifecycle {
  type: "agent_message" | "reasoning" | "web_search" | "error";
  status: "started" | "completed";
}

interface BoundedOutput {
  chunks: Buffer[];
  byteLength: number;
  exceeded: boolean;
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
    const stdout = createBoundedOutput();
    const stderr = createBoundedOutput();
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
      appendBounded(stdout, chunk, maxOutputBytes);
    };
    const onStderr = (chunk: Buffer | string) => {
      appendBounded(stderr, chunk, maxOutputBytes);
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
            stdout: readBoundedOutput(stdout).trimEnd(),
            stderr: readBoundedOutput(stderr).trimEnd(),
            command: commandDetails,
          }),
        );
      });
    };
    const settleAfterVerifiedTermination = () => {
      settle(() => {
        const rawStdout = readBoundedOutput(stdout).trimEnd();
        const finalStderr = readBoundedOutput(stderr).trimEnd();

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
        const rawStdout = readBoundedOutput(stdout).trimEnd();
        const finalStderr = readBoundedOutput(stderr).trimEnd();

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

        if (stdout.exceeded || stderr.exceeded) {
          reject(
            new CodexRunnerError({
              message: "Codex output exceeded the configured byte limit.",
              code: "INVALID_OUTPUT",
              stdout: rawStdout,
              stderr: finalStderr,
              command: commandDetails,
            }),
          );
          return;
        }

        try {
          const parsed = parseCodexOutput(rawStdout, options.webSearch === true);
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
            stdout: readBoundedOutput(stdout).trimEnd(),
            stderr: readBoundedOutput(stderr).trimEnd(),
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

function parseCodexOutput(
  rawStdout: string,
  webSearchAllowed: boolean,
): ParsedCodexOutput {
  const messages: string[] = [];
  const items = new Map<string, ParsedItemLifecycle>();
  let usage: CodexUsage | undefined;
  let phase: "thread" | "turn" | "active" | "completed" = "thread";
  let codeModeDisabledWarningSeen = false;

  for (const line of rawStdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const event = parseRecord(line);
    if (!event || typeof event.type !== "string") {
      throw new Error("Codex output contained a malformed JSONL event.");
    }
    if (phase === "completed") {
      throw new Error("Codex JSONL output continued after turn completion.");
    }

    if (event.type === "thread.started") {
      if (
        phase !== "thread" ||
        typeof event.thread_id !== "string" ||
        !event.thread_id.trim()
      ) {
        throw new Error("Codex JSONL output contained an invalid thread start.");
      }
      phase = "turn";
      continue;
    }

    if (event.type === "turn.started") {
      if (phase !== "turn") {
        throw new Error("Codex JSONL output contained an invalid turn start.");
      }
      phase = "active";
      continue;
    }

    if (
      event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed"
    ) {
      if (!isRecord(event.item)) {
        throw new Error("Codex JSONL output contained an invalid item event.");
      }
      const itemId = event.item.id;
      const itemType = event.item.type;
      if (typeof itemId !== "string" || !itemId.trim() || typeof itemType !== "string") {
        throw new Error("Codex JSONL output contained an invalid item event.");
      }

      const existing = items.get(itemId);
      if (existing && existing.type !== itemType) {
        throw new Error("Codex JSONL output changed an item type.");
      }

      if (phase === "turn") {
        if (
          codeModeDisabledWarningSeen ||
          existing ||
          event.type !== "item.completed" ||
          itemType !== "error" ||
          event.item.message !== CODE_MODE_DISABLED_WARNING
        ) {
          throw new Error("Codex JSONL output contained an invalid pre-turn item.");
        }
        codeModeDisabledWarningSeen = true;
        items.set(itemId, { type: "error", status: "completed" });
        continue;
      }

      if (phase !== "active") {
        throw new Error("Codex JSONL output contained an invalid item event.");
      }

      if (itemType === "agent_message") {
        if (
          existing ||
          event.type !== "item.completed" ||
          typeof event.item.text !== "string"
        ) {
          throw new Error("Codex JSONL output contained an invalid agent message.");
        }
        items.set(itemId, { type: "agent_message", status: "completed" });
        messages.push(event.item.text);
        continue;
      }
      if (itemType === "reasoning") {
        if (
          existing ||
          event.type !== "item.completed" ||
          typeof event.item.text !== "string"
        ) {
          throw new Error("Codex JSONL output contained an invalid reasoning item.");
        }
        items.set(itemId, { type: "reasoning", status: "completed" });
        continue;
      }
      if (itemType === "web_search" && webSearchAllowed) {
        if (event.type === "item.started") {
          if (existing) {
            throw new Error("Codex JSONL output contained a duplicate item start.");
          }
          items.set(itemId, { type: "web_search", status: "started" });
          continue;
        }
        if (!existing || existing.status !== "started") {
          throw new Error("Codex JSONL output contained an invalid item lifecycle.");
        }
        if (event.type === "item.completed") {
          items.set(itemId, { type: "web_search", status: "completed" });
        }
        continue;
      }
      throw new Error("Codex JSONL output contained a forbidden item type.");
    }

    if (event.type === "turn.completed") {
      if (phase !== "active" || !isRecord(event.usage)) {
        throw new Error("Codex JSONL output contained an invalid turn completion.");
      }
      if ([...items.values()].some((item) => item.status !== "completed")) {
        throw new Error("Codex JSONL output completed with unfinished items.");
      }
      usage = {
        inputTokens: readTokenCount(event.usage.input_tokens),
        cachedInputTokens: readTokenCount(event.usage.cached_input_tokens),
        outputTokens: readTokenCount(event.usage.output_tokens),
        reasoningOutputTokens: readTokenCount(event.usage.reasoning_output_tokens),
      };
      phase = "completed";
      continue;
    }

    throw new Error("Codex JSONL output contained an unsupported event type.");
  }

  if (phase !== "completed") {
    throw new Error("Codex JSONL output did not contain a completed turn.");
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Codex JSONL output contained invalid token usage.");
  }
  return value;
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

function createBoundedOutput(): BoundedOutput {
  return { chunks: [], byteLength: 0, exceeded: false };
}

function appendBounded(
  output: BoundedOutput,
  chunk: Buffer | string,
  maxOutputBytes: number,
): void {
  const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8");
  const remaining = Math.max(0, maxOutputBytes - output.byteLength);
  if (bytes.byteLength > remaining) {
    output.exceeded = true;
  }
  if (remaining === 0) {
    return;
  }
  const bounded = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining);
  output.chunks.push(bounded);
  output.byteLength += bounded.byteLength;
}

function readBoundedOutput(output: BoundedOutput): string {
  return Buffer.concat(output.chunks, output.byteLength).toString("utf8");
}
