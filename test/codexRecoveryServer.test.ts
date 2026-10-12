import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { CodexRunnerError, createCodexRunner, type CodexRunner, type SpawnFn } from "../src/codexRunner.js";
import { createServer } from "../src/server.js";

const config = { host: "127.0.0.1", port: 3001, codexBackend: "exec" as const, codexWorkspace: "C:/empty", codexHome: "C:/home", codexTimeoutMs: 120000, codexReasoningEffort: "medium" as const, callLoggingEnabled: false, callLogDir: join(tmpdir(), "unused-codex-recovery") };
const endpoints = ["/v1/responses", "/v1/chat/completions"];
const payload = (endpoint: string, model = "client-model") => endpoint === "/v1/responses" ? { model, input: "private input secret" } : { model, messages: [{ role: "user", content: "private input secret" }] };

function operationalRunner(outputs: ("transient" | "success" | "wait")[]) {
  const calls: { args: string[]; prompt?: string }[] = [];
  const cleaned: number[] = [];
  let entered!: () => void;
  let firstCleaned!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const cleanupFinished = new Promise<void>((resolve) => { firstCleaned = resolve; });
  const spawn: SpawnFn = (_command, args) => {
    const index = calls.length;
    const call: { args: string[]; prompt?: string } = { args };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: (text: string) => void; end: () => void }; kill: () => boolean };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    child.stdin = { write: (text) => { call.prompt = text; }, end: () => queueMicrotask(() => {
      entered();
      if (outputs[index] === "wait") return;
      const events: unknown[] = [{ type: "thread.started", thread_id: "thread" }, { type: "turn.started" }];
      if (outputs[index] === "transient") events.push({ type: "turn.failed", error: { message: "unexpected status 504 Gateway Timeout: unavailable" } });
      else events.push({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "READY" } }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
      child.stdout.emit("data", events.map((event) => JSON.stringify(event)).join("\n"));
      child.emit("close", outputs[index] === "transient" ? 1 : 0);
    }) };
    return child as never;
  };
  let workspace = 0;
  const runner = createCodexRunner({ command: "codex", workspace: "C:/empty", codexHome: "C:/home", timeoutMs: 120000, spawn, requestWorkspaceFactory: async () => {
    const index = ++workspace;
    return { path: `C:/request-${index}`, cleanup: async () => { cleaned.push(index); firstCleaned(); } };
  } });
  return { runner, calls, cleaned, started, cleanupFinished };
}

describe("Codex recovery route contracts", () => {
  it.each(endpoints.flatMap((endpoint) => ["execution", "backoff"].map((phase) => [endpoint, phase])))("stops the real retry lifecycle on %s cancellation during %s", async (endpoint, phase) => {
    const controller = new AbortController();
    const operation = operationalRunner([phase === "backoff" ? "transient" : "wait", "success"]);
    const app = createServer({ config, runner: operation.runner, requestSignal: () => controller.signal });
    try {
      const pending = app.inject({ method: "POST", url: endpoint, payload: payload(endpoint) }).then((reply) => reply);
      await (phase === "backoff" ? operation.cleanupFinished : operation.started);
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      const reply = await pending;
      expect(reply.statusCode).toBe(499);
      expect(operation.calls).toHaveLength(1);
      expect(operation.cleaned).toEqual([1]);
    } finally { await app.close(); }
  });

  it("retains prepared image order and client configuration across a real retry", async () => {
    const operation = operationalRunner(["transient", "success"]);
    const imageCleanups: string[] = [];
    const app = createServer({ config, runner: operation.runner, prepareRemoteImage: async (url) => ({ path: url.endsWith("first.png") ? "C:/first.png" : "C:/second.png", reason: null, cleanup: async () => { imageCleanups.push(url); } }) });
    try {
      const reply = await app.inject({ method: "POST", url: "/v1/responses", payload: { model: "client-model", reasoning: { effort: "high" }, input: [{ role: "user", content: [{ type: "input_text", text: "Compare" }, { type: "input_image", image_url: "https://example.test/first.png" }, { type: "input_image", image_url: "https://example.test/second.png" }] }] } });
      expect(reply.statusCode).toBe(200);
      expect(operation.calls).toHaveLength(2);
      for (const call of operation.calls) {
        const first = call.args.indexOf("--image");
        expect(call.args.slice(first, first + 4)).toEqual(["--image", "C:/first.png", "--image", "C:/second.png"]);
        expect(call.args.slice(call.args.indexOf("--model"), call.args.indexOf("--model") + 2)).toEqual(["--model", "client-model"]);
        expect(call.args).toContain('model_reasoning_effort="high"');
      }
      expect(operation.calls[0].prompt).toBe(operation.calls[1].prompt);
      expect(operation.cleaned).toEqual([1, 2]);
      expect(imageCleanups).toEqual(["https://example.test/first.png", "https://example.test/second.png"]);
    } finally { await app.close(); }
  });
  it.each(endpoints)("issues a server correlation id before validation on %s", async (endpoint) => {
    const runner: CodexRunner = { run: async () => "unused" };
    const app = createServer({ config, runner });
    try {
      const reply = await app.inject({ method: "POST", url: endpoint, headers: { "x-request-id": "call_00000000000000000000000000000000" }, payload: payload(endpoint, "") });
      expect(reply.statusCode).toBe(400);
      expect(reply.headers["x-request-id"]).toMatch(/^call_[0-9a-f]{32}$/);
      expect(reply.headers["x-request-id"]).not.toBe("call_00000000000000000000000000000000");
    } finally { await app.close(); }
  });

  it.each(endpoints)("logs only typed error diagnostics with optional call logging off on %s", async (endpoint) => {
    const runner: CodexRunner = { run: async () => "unused", runWithDetails: async () => {
      const error = new CodexRunnerError({ code: "NON_ZERO_EXIT", message: "raw private error", exitCode: 1, stdout: "secret generated output", stderr: "Authorization Bearer secret https://private.test C:/private-path" });
      error.diagnostics = { attemptCount: 3, elapsedMs: 3200, runnerCode: "NON_ZERO_EXIT", exitCode: 1, failureCategory: "upstream_transient", upstreamStatus: 503, reconnectCount: 2, captureComplete: true };
      throw error;
    } };
    const app = createServer({ config, runner });
    const logs: unknown[] = [];
    app.addHook("onRequest", (request, _reply, done) => {
      vi.spyOn(request.log, "warn").mockImplementation((fields: unknown) => { logs.push(fields); });
      done();
    });
    try {
      const reply = await app.inject({ method: "POST", url: endpoint, payload: payload(endpoint) });
      expect(reply.statusCode).toBe(500);
      expect(logs).toContainEqual({ callId: reply.headers["x-request-id"], attemptCount: 3, elapsedMs: 3200, runnerCode: "NON_ZERO_EXIT", exitCode: 1, failureCategory: "upstream_transient", upstreamStatus: 503, reconnectCount: 2, captureComplete: true });
      expect(JSON.stringify(logs)).not.toMatch(/secret|private|Authorization|client-model|raw/);
      expect(reply.body).not.toMatch(/secret|private|Authorization|raw/);
    } finally { await app.close(); }
  });

  it.each(endpoints)("passes client cancellation into execution on %s", async (endpoint) => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const runner: CodexRunner = { run: async () => "unused", runWithDetails: async (_prompt, options) => new Promise((_resolve, reject) => {
      entered();
      if (!options?.signal) { reject(new Error("missing cancellation signal")); return; }
      options.signal.addEventListener("abort", () => reject(new CodexRunnerError({ code: "CANCELLED", message: "cancelled" })), { once: true });
    }) };
    const app = createServer({ config, runner, requestSignal: () => controller.signal });
    try {
      const pending = app.inject({ method: "POST", url: endpoint, payload: payload(endpoint) });
      const replyPromise = pending.then((reply) => reply);
      await started;
      controller.abort();
      const reply = await replyPromise;
      expect(reply.statusCode).toBe(499);
      expect(reply.json().error.code).toBe("request_cancelled");
    } finally { await app.close(); }
  });

  it.each(endpoints)("logs recovered executions without retaining private output on %s", async (endpoint) => {
    const runner: CodexRunner = { run: async () => "unused", runWithDetails: async () => ({ stdout: "private output secret", stderr: "secret", diagnostics: { attemptCount: 2, elapsedMs: 1300, failureCategory: "recovered", upstreamStatus: 503, reconnectCount: 2, captureComplete: true } }) };
    const app = createServer({ config, runner });
    const logs: unknown[] = [];
    app.addHook("onRequest", (request, _reply, done) => {
      vi.spyOn(request.log, "info").mockImplementation((fields: unknown) => { logs.push(fields); });
      done();
    });
    try {
      const reply = await app.inject({ method: "POST", url: endpoint, payload: payload(endpoint) });
      expect(reply.statusCode).toBe(200);
      expect(logs).toContainEqual({ callId: reply.headers["x-request-id"], attemptCount: 2, elapsedMs: 1300, failureCategory: "recovered", upstreamStatus: 503, reconnectCount: 2, captureComplete: true });
      expect(JSON.stringify(logs)).not.toMatch(/private|secret/);
    } finally { await app.close(); }
  });
});
