import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createAppServerCodexRunner,
  type AppServerWebSocket,
} from "../src/appServerRunner.js";
import type { SpawnFn } from "../src/codexRunner.js";

class FakeReadable extends EventEmitter {
  push(chunk: string | null): void {
    if (chunk !== null) {
      this.emit("data", chunk);
    }
  }
}

class FakeChildProcess extends EventEmitter {
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  kill = vi.fn();
}

class FakeWebSocket implements AppServerWebSocket {
  readonly sent: unknown[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createFakeSpawn(child: FakeChildProcess) {
  return vi.fn<SpawnFn>(() => child as never);
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("app-server Codex runner", () => {
  it("starts a managed app-server with lightweight feature flags", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const socket = new FakeWebSocket();
    const runner = createAppServerCodexRunner({
      command: "codex",
      commandArgs: ["C:/codex/codex.js"],
      workspace: "C:/workspace",
      timeoutMs: 1000,
      managedPort: 4567,
      disableApps: true,
      disablePlugins: true,
      disableShellSnapshot: true,
      disableNodeReplMcp: true,
      spawn,
      webSocketFactory: () => socket,
    });

    const resultPromise = runner.run("Hello");
    await waitUntil(() => socket.listenerCount("open") > 0);
    socket.open();
    await waitUntil(() => socket.sent.length > 0);
    socket.message({ id: "1", result: { userAgent: "codex", codexHome: "C:/home" } });
    socket.message({
      id: "2",
      result: {
        thread: { id: "thread-1" },
        instructionSources: [],
        model: "gpt-5.5",
        cwd: "C:/workspace",
      },
    });
    socket.message({ id: "3", result: { turn: { id: "turn-1" } } });
    socket.message({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "Hi", phase: "final_answer" },
      },
    });
    socket.message({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });

    await expect(resultPromise).resolves.toBe("Hi");
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      [
        "C:/codex/codex.js",
        "app-server",
        "--listen",
        "ws://127.0.0.1:4567",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "shell_snapshot",
        "-c",
        "mcp_servers.node_repl.enabled=false",
      ],
      expect.objectContaining({
        cwd: "C:/workspace",
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it("uses a free local port when the managed app-server port is zero", async () => {
    const child = new FakeChildProcess();
    const spawn = createFakeSpawn(child);
    const socket = new FakeWebSocket();
    let connectedUrl = "";
    const runner = createAppServerCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      timeoutMs: 1000,
      managedPort: 0,
      spawn,
      webSocketFactory: (url) => {
        connectedUrl = url;
        return socket;
      },
    });

    const resultPromise = runner.run("Hello");
    await waitUntil(() => socket.listenerCount("open") > 0);
    socket.open();
    await waitUntil(() => socket.sent.length > 0);
    socket.message({ id: "1", result: { userAgent: "codex", codexHome: "C:/home" } });
    socket.message({
      id: "2",
      result: { thread: { id: "thread-1" }, cwd: "C:/workspace" },
    });
    socket.message({ id: "3", result: { turn: { id: "turn-1" } } });
    socket.message({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "Hi", phase: "final_answer" },
      },
    });
    socket.message({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });

    await expect(resultPromise).resolves.toBe("Hi");
    expect(connectedUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(connectedUrl).not.toBe("ws://127.0.0.1:0");
    expect(spawn.mock.calls[0]?.[1]).toContain(connectedUrl);
  });

  it("sends one ephemeral thread and turn with an optional output schema", async () => {
    const socket = new FakeWebSocket();
    const runner = createAppServerCodexRunner({
      command: "codex",
      workspace: "C:/workspace",
      timeoutMs: 1000,
      appServerUrl: "ws://127.0.0.1:3032",
      webSocketFactory: () => socket,
    });
    const outputSchema = {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };

    const resultPromise = runner.runWithDetails!("input: Hello", { outputSchema });
    await waitUntil(() => socket.listenerCount("open") > 0);
    socket.open();
    await waitUntil(() => socket.sent.length > 0);
    expect(socket.sent[0]).toMatchObject({
      method: "initialize",
      id: "1",
      params: {
        clientInfo: { name: "codexapi", title: "codexapi", version: "0.1.0" },
      },
    });

    socket.message({ id: "1", result: { userAgent: "codex", codexHome: "C:/home" } });
    expect(socket.sent[1]).toMatchObject({
      method: "thread/start",
      id: "2",
      params: {
        cwd: "C:/workspace",
        runtimeWorkspaceRoots: ["C:/workspace"],
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: true,
        multiAgentMode: "none",
      },
    });

    socket.message({
      id: "2",
      result: {
        thread: { id: "thread-1" },
        instructionSources: ["C:/Users/me/.codex/AGENTS.md"],
        model: "gpt-5.5",
        cwd: "C:/workspace",
      },
    });
    expect(socket.sent[2]).toEqual({
      method: "turn/start",
      id: "3",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "input: Hello", text_elements: [] }],
        outputSchema,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        multiAgentMode: "none",
      },
    });

    socket.message({ id: "3", result: { turn: { id: "turn-1" } } });
    socket.message({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          text: "{\"answer\":\"OK\"}",
          phase: "final_answer",
        },
      },
    });
    socket.message({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });

    await expect(resultPromise).resolves.toEqual({
      stdout: "{\"answer\":\"OK\"}",
      stderr: "",
      command: {
        executable: "codex app-server",
        args: ["connect", "ws://127.0.0.1:3032"],
        cwd: "C:/workspace",
        shell: false,
      },
    });
  });
});
