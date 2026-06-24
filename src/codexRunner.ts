import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type CodexRunnerErrorCode = "NON_ZERO_EXIT" | "SPAWN_ERROR" | "TIMEOUT";

export class CodexRunnerError extends Error {
  readonly code: CodexRunnerErrorCode;
  readonly exitCode?: number | null;
  readonly stderr?: string;

  constructor({
    message,
    code,
    exitCode,
    stderr,
  }: {
    message: string;
    code: CodexRunnerErrorCode;
    exitCode?: number | null;
    stderr?: string;
  }) {
    super(message);
    this.name = "CodexRunnerError";
    this.code = code;
    this.exitCode = exitCode;
    this.stderr = stderr;
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
  timeoutMs: number;
  maxOutputBytes?: number;
  spawn?: SpawnFn;
}

export interface CodexRunner {
  run(prompt: string): Promise<string>;
}

export function createCodexRunner(config: CodexRunnerConfig): CodexRunner {
  return {
    run(prompt: string) {
      return runCodexPrompt(prompt, config);
    },
  };
}

export function runCodexPrompt(
  prompt: string,
  {
    command,
    commandArgs = [],
    workspace,
    profile,
    timeoutMs,
    maxOutputBytes = 1024 * 1024,
    spawn = nodeSpawn,
  }: CodexRunnerConfig,
): Promise<string> {
  const args = [
    ...commandArgs,
    "exec",
    prompt,
    "--skip-git-repo-check",
    "--profile",
    profile,
  ];

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, args, {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      settle(() => {
        child.kill();
        reject(
          new CodexRunnerError({
            message: `Codex command timed out after ${timeoutMs} ms.`,
            code: "TIMEOUT",
            stderr,
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
            stderr,
          }),
        );
      });
    });

    child.on("close", (code: number | null) => {
      settle(() => {
        if (code === 0) {
          resolve(stdout.trimEnd());
          return;
        }

        reject(
          new CodexRunnerError({
            message: `Codex command exited with code ${code ?? "unknown"}.`,
            code: "NON_ZERO_EXIT",
            exitCode: code,
            stderr: stderr.trimEnd(),
          }),
        );
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
