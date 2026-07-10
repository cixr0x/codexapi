import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import {
  CodexRunnerError,
  type CodexCommandDetails,
  type CodexRunOptions,
  type CodexRunResult,
  type CodexRunner,
  type SpawnFn,
} from "./codexRunner.js";

export interface AppServerWebSocketEvent {
  data?: unknown;
  message?: string;
}

export interface AppServerWebSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: AppServerWebSocketEvent) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type AppServerWebSocketFactory = (url: string) => AppServerWebSocket;

export interface AppServerCodexRunnerConfig {
  command: string;
  commandArgs?: string[];
  workspace: string;
  timeoutMs: number;
  appServerUrl?: string;
  managedPort?: number;
  startTimeoutMs?: number;
  disableApps?: boolean;
  disablePlugins?: boolean;
  disableShellSnapshot?: boolean;
  disableNodeReplMcp?: boolean;
  maxOutputBytes?: number;
  spawn?: SpawnFn;
  webSocketFactory?: AppServerWebSocketFactory;
}

interface ManagedAppServer {
  url: string;
  command: CodexCommandDetails;
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

interface AppServerMessage {
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

interface ThreadStartResult {
  thread?: { id?: string };
}

interface TurnStartResult {
  turn?: { id?: string };
}

interface ItemCompletedParams {
  turnId?: string;
  item?: {
    type?: string;
    text?: string;
    phase?: string | null;
  };
}

interface TurnCompletedParams {
  turn?: {
    id?: string;
    status?: string;
    error?: { message?: string; code?: string } | null;
  };
}

export function createAppServerCodexRunner(
  config: AppServerCodexRunnerConfig,
): CodexRunner {
  const runner = new AppServerCodexRunner(config);

  return {
    async run(prompt: string) {
      const result = await runner.runWithDetails(prompt);
      return result.stdout;
    },
    runWithDetails(prompt: string, options?: CodexRunOptions) {
      return runner.runWithDetails(prompt, options);
    },
  };
}

class AppServerCodexRunner {
  private managedServer?: ManagedAppServer;
  private startPromise?: Promise<ManagedAppServer | undefined>;

  constructor(private readonly config: AppServerCodexRunnerConfig) {}

  async runWithDetails(
    prompt: string,
    options: CodexRunOptions = {},
  ): Promise<CodexRunResult> {
    const managedServer = await this.ensureAppServer();
    const url = this.config.appServerUrl ?? managedServer?.url;
    if (!url) {
      throw new Error("App-server URL was not initialized.");
    }

    const command = managedServer?.command ?? externalAppServerCommand(url, this.config.workspace);
    const socket = await connectWebSocket(
      url,
      this.config.webSocketFactory ?? defaultWebSocketFactory,
      this.config.startTimeoutMs ?? 10000,
    );

    return runPromptOverSocket({
      socket,
      prompt,
      outputSchema: options.outputSchema,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      workspace: this.config.workspace,
      timeoutMs: this.config.timeoutMs,
      command,
      serverOutput: () => ({
        stdout: managedServer?.stdout ?? "",
        stderr: managedServer?.stderr ?? "",
      }),
    });
  }

  private ensureAppServer(): Promise<ManagedAppServer | undefined> {
    if (this.config.appServerUrl) {
      return Promise.resolve(undefined);
    }

    if (this.managedServer) {
      return Promise.resolve(this.managedServer);
    }

    if (!this.startPromise) {
      this.startPromise = this.startManagedAppServer();
    }

    return this.startPromise;
  }

  private async startManagedAppServer(): Promise<ManagedAppServer> {
    const port = this.config.managedPort
      ? this.config.managedPort
      : await findFreePort();
    const url = `ws://127.0.0.1:${port}`;
    const args = [
      ...(this.config.commandArgs ?? []),
      "app-server",
      "--listen",
      url,
      ...(this.config.disableApps ?? true ? ["--disable", "apps"] : []),
      ...(this.config.disablePlugins ?? true ? ["--disable", "plugins"] : []),
      ...(this.config.disableShellSnapshot ?? true
        ? ["--disable", "shell_snapshot"]
        : []),
      ...(this.config.disableNodeReplMcp ?? true
        ? ["-c", "mcp_servers.node_repl.enabled=false"]
        : []),
    ];
    const command: CodexCommandDetails = {
      executable: this.config.command,
      args,
      cwd: this.config.workspace,
      shell: false,
    };
    const child = (this.config.spawn ?? nodeSpawn)(this.config.command, args, {
      cwd: this.config.workspace,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const server: ManagedAppServer = {
      url,
      command,
      child,
      stdout: "",
      stderr: "",
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      server.stdout = appendBounded(
        server.stdout,
        chunk,
        this.config.maxOutputBytes ?? 1024 * 1024,
      );
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      server.stderr = appendBounded(
        server.stderr,
        chunk,
        this.config.maxOutputBytes ?? 1024 * 1024,
      );
    });
    child.on("close", () => {
      if (this.managedServer === server) {
        this.managedServer = undefined;
        this.startPromise = undefined;
      }
    });
    child.on("error", (error: Error) => {
      server.stderr = appendBounded(
        server.stderr,
        error.message,
        this.config.maxOutputBytes ?? 1024 * 1024,
      );
      if (this.managedServer === server) {
        this.managedServer = undefined;
        this.startPromise = undefined;
      }
    });

    this.managedServer = server;
    return server;
  }
}

function runPromptOverSocket({
  socket,
  prompt,
  outputSchema,
  model,
  reasoningEffort,
  workspace,
  timeoutMs,
  command,
  serverOutput,
}: {
  socket: AppServerWebSocket;
  prompt: string;
  outputSchema: unknown;
  model: string | undefined;
  reasoningEffort: string | undefined;
  workspace: string;
  timeoutMs: number;
  command: CodexCommandDetails;
  serverOutput: () => { stdout: string; stderr: string };
}): Promise<CodexRunResult> {
  return new Promise((resolve, reject) => {
    let nextId = 1;
    let settled = false;
    let initializeId = "";
    let threadStartId = "";
    let turnStartId = "";
    let threadId = "";
    let turnId = "";
    const finalMessages: string[] = [];
    const otherMessages: string[] = [];

    const timeout = setTimeout(() => {
      if (threadId && turnId) {
        send("turn/interrupt", { threadId, turnId });
      }
      settleReject(
        new CodexRunnerError({
          message: `Codex app-server turn timed out after ${timeoutMs} ms.`,
          code: "TIMEOUT",
          stderr: combinedStderr(serverOutput()),
          command,
        }),
      );
    }, timeoutMs);

    socket.addEventListener("message", (event) => {
      const message = parseMessage(event.data);
      if (!message) {
        return;
      }

      if (message.id === initializeId) {
        if (message.error) {
          settleReject(appServerError("initialize", message.error, command, serverOutput()));
          return;
        }

        notify("initialized", {});
        threadStartId = send("thread/start", {
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: true,
        });
        return;
      }

      if (message.id === threadStartId) {
        if (message.error) {
          settleReject(
            appServerError("thread/start", message.error, command, serverOutput()),
          );
          return;
        }

        try {
          threadId = readThreadId(message.result);
        } catch (error) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        turnStartId = send("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          ...(outputSchema !== undefined ? { outputSchema } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { effort: reasoningEffort } : {}),
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        });
        return;
      }

      if (message.id === turnStartId) {
        if (message.error) {
          settleReject(appServerError("turn/start", message.error, command, serverOutput()));
          return;
        }

        try {
          turnId = readTurnId(message.result);
        } catch (error) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }

      if (message.method === "item/completed") {
        const params = message.params as ItemCompletedParams;
        if (params.turnId !== turnId || params.item?.type !== "agentMessage") {
          return;
        }

        const text = params.item.text ?? "";
        if (params.item.phase === "final_answer") {
          finalMessages.push(text);
        } else {
          otherMessages.push(text);
        }
        return;
      }

      if (message.method === "turn/completed") {
        const params = message.params as TurnCompletedParams;
        if (params.turn?.id !== turnId) {
          return;
        }

        if (params.turn.status !== "completed") {
          settleReject(
            new CodexRunnerError({
              message: `Codex app-server turn ended with status ${params.turn.status ?? "unknown"}.`,
              code: "NON_ZERO_EXIT",
              stderr: params.turn.error?.message ?? combinedStderr(serverOutput()),
              command,
            }),
          );
          return;
        }

        settleResolve({
          stdout: (finalMessages.length ? finalMessages : otherMessages)
            .join("\n")
            .trimEnd(),
          stderr: combinedStderr(serverOutput()),
          command,
        });
      }
    });

    socket.addEventListener("error", (event) => {
      settleReject(
        new CodexRunnerError({
          message: `Codex app-server websocket error${event.message ? `: ${event.message}` : "."}`,
          code: "SPAWN_ERROR",
          stderr: combinedStderr(serverOutput()),
          command,
        }),
      );
    });

    socket.addEventListener("close", () => {
      settleReject(
        new CodexRunnerError({
          message: "Codex app-server websocket closed before the turn completed.",
          code: "SPAWN_ERROR",
          stderr: combinedStderr(serverOutput()),
          command,
        }),
      );
    });

    initializeId = send("initialize", {
      clientInfo: { name: "codexapi", title: "codexapi", version: "0.1.0" },
    });

    function notify(method: string, params: unknown): void {
      socket.send(JSON.stringify({ method, params }));
    }

    function send(method: string, params: unknown): string {
      const id = String(nextId++);
      socket.send(JSON.stringify({ method, id, params }));
      return id;
    }

    function settleResolve(result: CodexRunResult): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.close(1000, "done");
      resolve(result);
    }

    function settleReject(error: Error): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.close(1000, "error");
      reject(error);
    }
  });
}

async function connectWebSocket(
  url: string,
  webSocketFactory: AppServerWebSocketFactory,
  timeoutMs: number,
): Promise<AppServerWebSocket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      return await openWebSocket(url, webSocketFactory, Math.max(1, deadline - Date.now()));
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out connecting to Codex app-server at ${url}.`);
}

function openWebSocket(
  url: string,
  webSocketFactory: AppServerWebSocketFactory,
  timeoutMs: number,
): Promise<AppServerWebSocket> {
  return new Promise((resolve, reject) => {
    const socket = webSocketFactory(url);
    let settled = false;
    const timeout = setTimeout(() => {
      settle(() => {
        socket.close();
        reject(new Error(`Timed out connecting to Codex app-server at ${url}.`));
      });
    }, timeoutMs);

    socket.addEventListener("open", () => {
      settle(() => resolve(socket));
    });
    socket.addEventListener("error", (event) => {
      settle(() => {
        socket.close();
        reject(new Error(event.message || `Failed to connect to Codex app-server at ${url}.`));
      });
    });
    socket.addEventListener("close", () => {
      settle(() => reject(new Error(`Codex app-server connection closed at ${url}.`)));
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

function defaultWebSocketFactory(url: string): AppServerWebSocket {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => AppServerWebSocket })
    .WebSocket;
  if (!WebSocketCtor) {
    throw new Error("This Node.js runtime does not provide a global WebSocket.");
  }

  return new WebSocketCtor(url);
}

function parseMessage(data: unknown): AppServerMessage | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as AppServerMessage;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function readThreadId(result: unknown): string {
  const id = (result as ThreadStartResult | undefined)?.thread?.id;
  if (!id) {
    throw new Error("Codex app-server thread/start response did not include thread.id.");
  }

  return id;
}

function readTurnId(result: unknown): string {
  const id = (result as TurnStartResult | undefined)?.turn?.id;
  if (!id) {
    throw new Error("Codex app-server turn/start response did not include turn.id.");
  }

  return id;
}

function appServerError(
  method: string,
  error: { message?: string; code?: number },
  command: CodexCommandDetails,
  output: { stdout: string; stderr: string },
): CodexRunnerError {
  return new CodexRunnerError({
    message: `Codex app-server ${method} failed: ${error.message ?? "unknown error"}.`,
    code: "NON_ZERO_EXIT",
    stderr: combinedStderr(output),
    command,
  });
}

function externalAppServerCommand(url: string, workspace: string): CodexCommandDetails {
  return {
    executable: "codex app-server",
    args: ["connect", url],
    cwd: workspace,
    shell: false,
  };
}

function combinedStderr(output: { stdout: string; stderr: string }): string {
  return [output.stderr.trimEnd(), output.stdout.trimEnd()].filter(Boolean).join("\n");
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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error("Unable to allocate a free app-server port."));
        }
      });
    });
    server.on("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
