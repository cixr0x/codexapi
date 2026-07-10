import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CodexRunnerErrorCode =
  | "NON_ZERO_EXIT"
  | "SPAWN_ERROR"
  | "TIMEOUT"
  | "INVALID_OUTPUT";

export class CodexRunnerError extends Error {
  readonly code: CodexRunnerErrorCode;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly command?: CodexCommandDetails;

  constructor({
    message,
    code,
    exitCode,
    stdout,
    stderr,
    command,
  }: {
    message: string;
    code: CodexRunnerErrorCode;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    command?: CodexCommandDetails;
  }) {
    super(message);
    this.name = "CodexRunnerError";
    this.code = code;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.command = command;
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
  profile: string;
  ignoreUserConfig?: boolean;
  disablePlugins?: boolean;
  disableShellSnapshot?: boolean;
  ephemeral?: boolean;
  ignoreRules?: boolean;
  timeoutMs: number;
  maxOutputBytes?: number;
  spawn?: SpawnFn;
}

export interface CodexRunOptions {
  model?: string;
  reasoningEffort?: string;
  outputSchema?: unknown;
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

  try {
    await writeFile(schemaPath, JSON.stringify(options.outputSchema), "utf8");
    return await runCodexProcess(prompt, config, options, schemaPath);
  } finally {
    await rm(schemaDir, { recursive: true, force: true });
  }
}

function runCodexProcess(
  prompt: string,
  {
    command,
    commandArgs = [],
    workspace,
    profile,
    ignoreUserConfig = false,
    disablePlugins = false,
    disableShellSnapshot = false,
    ephemeral = false,
    ignoreRules = false,
    timeoutMs,
    maxOutputBytes = 1024 * 1024,
    spawn = nodeSpawn,
  }: CodexRunnerConfig,
  options: CodexRunOptions,
  outputSchemaPath?: string,
): Promise<CodexRunResult> {
  const model = normalizeStringOption(options.model);
  const reasoningEffort = normalizeStringOption(options.reasoningEffort);
  const args = [
    ...commandArgs,
    "exec",
    "-",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "danger-full-access",
    "--dangerously-bypass-approvals-and-sandbox",
    ...(model ? ["--model", model] : []),
    ...(reasoningEffort
      ? ["-c", `model_reasoning_effort=${tomlString(reasoningEffort)}`]
      : []),
    ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
    ...(ignoreUserConfig ? ["--ignore-user-config"] : ["--profile", profile]),
    ...(disablePlugins ? ["--disable", "plugins"] : []),
    ...(disableShellSnapshot ? ["--disable", "shell_snapshot"] : []),
    ...(ephemeral ? ["--ephemeral"] : []),
    ...(ignoreRules ? ["--ignore-rules"] : []),
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

    const child = spawn(command, args, {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin?.write(prompt);
    child.stdin?.end();

    const timeout = setTimeout(() => {
      settle(() => {
        child.kill();
        reject(
          new CodexRunnerError({
            message: `Codex command timed out after ${timeoutMs} ms.`,
            code: "TIMEOUT",
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            command: commandDetails,
          }),
        );
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes);
    });

    child.on("error", (error: Error) => {
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
    });

    child.on("close", (code: number | null) => {
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
    });

    function settle(action: () => void): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      action();
    }
  });
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
