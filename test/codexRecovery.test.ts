import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexRunner, type CodexRunnerConfig, type SpawnFn } from "../src/codexRunner.js";

const RECONNECT_2 = "Reconnecting... 2/5 (unexpected status 503 Service Unavailable: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.)";
const RECONNECT_3 = "Reconnecting... 3/5 (unexpected status 503 Service Unavailable: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.)";
const START = [{ type: "thread.started", thread_id: "thread-1" }, { type: "turn.started" }];
const USAGE = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 };
const FINISH = [{ type: "item.completed", item: { id: "answer", type: "agent_message", text: '{"classification":"LIKELY_BOARDGAME","confidence":99,"reasoning":"Boxed game"}' } }, { type: "turn.completed", usage: USAGE }];
const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const observe = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
const terminal = (message = "unexpected status 503 Service Unavailable: upstream unavailable") => jsonl([...START, { type: "error", message }, { type: "turn.failed", error: { message } }]);

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: { write: (prompt: string) => void; end: () => void };
  kill = vi.fn(() => { queueMicrotask(() => this.emit("close", null)); return true; });
  constructor(action: (child: Child) => void) {
    super();
    this.stdin = { write: () => undefined, end: () => queueMicrotask(() => action(this)) };
  }
}

function harness(outputs: { stdout: string; code: number; stderr?: string; delayMs?: number; hang?: boolean }[], overrides: Partial<CodexRunnerConfig> = {}) {
  const lifecycle: string[] = [];
  const children: Child[] = [];
  let workspaceCount = 0;
  const spawn: SpawnFn = () => {
    lifecycle.push("spawn");
    const output = outputs[children.length] ?? { stdout: "", code: 1 };
    const child = new Child((process) => {
      if (output.hang) return;
      const finish = () => {
        process.stdout.emit("data", `${output.stdout}\n`);
        if (output.stderr) process.stderr.emit("data", output.stderr);
        process.emit("close", output.code);
      };
      if (output.delayMs) setTimeout(finish, output.delayMs);
      else finish();
    });
    children.push(child);
    return child as never;
  };
  const runner = createCodexRunner({
    command: "codex", workspace: "C:/empty", codexHome: "C:/home", timeoutMs: 120_000,
    spawn,
    requestWorkspaceFactory: async () => ({
      path: `C:/request-${++workspaceCount}`,
      cleanup: async () => { lifecycle.push("cleanup"); },
    }),
    ...overrides,
  });
  return { runner, lifecycle, children };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded Codex recovery", () => {
  it("accepts the captured active-turn reconnects only after valid completion", async () => {
    const { runner } = harness([{ stdout: jsonl([...START, { type: "error", message: RECONNECT_2 }, { type: "error", message: RECONNECT_3 }, ...FINISH]), code: 0 }]);
    await expect(runner.runWithDetails!("Classify" )).resolves.toMatchObject({ stdout: FINISH[0].item!.text, diagnostics: { attemptCount: 1, reconnectCount: 2 } });
  });

  it.each([
    ["stale output", [...START, FINISH[0], { type: "error", message: RECONNECT_2 }, FINISH[1]]],
    ["pre-turn reconnect", [START[0], { type: "error", message: RECONNECT_2 }, START[1], ...FINISH]],
    ["changed detail", [...START, { type: "error", message: `${RECONNECT_2} changed` }, ...FINISH]],
    ["bad progress", [...START, { type: "error", message: RECONNECT_2.replace("2/5", "6/5") }, ...FINISH]],
    ["duplicate progress", [...START, { type: "error", message: RECONNECT_2 }, { type: "error", message: RECONNECT_2 }, ...FINISH]],
    ["fatal turn", [...START, { type: "error", message: RECONNECT_2 }, { type: "turn.failed", error: { message: "failed" } }, ...FINISH]],
  ])("rejects %s even with exit zero", async (_name, events) => {
    const { runner, children } = harness([{ stdout: jsonl(events), code: 0 }]);
    await expect(runner.runWithDetails!("Classify")).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(children).toHaveLength(1);
  });

  it("retries a verified terminal 503 only after cleaning the first attempt", async () => {
    vi.useFakeTimers();
    const { runner, lifecycle } = harness([{ stdout: terminal(), code: 1 }, { stdout: jsonl([...START, ...FINISH]), code: 0 }]);
    const result = runner.runWithDetails!("Classify");
    const observed = observe(result);
    await vi.advanceTimersByTimeAsync(1300);
    expect(await observed).toMatchObject({ value: { stdout: FINISH[0].item!.text, diagnostics: { attemptCount: 2, upstreamStatus: 503 } } });
    expect(lifecycle).toEqual(["spawn", "cleanup", "spawn", "cleanup"]);
  });

  it("retries a terminal transient failure after the exact pinned startup advisories", async () => {
    vi.useFakeTimers();
    const warning = "Filesystem deny-read glob `:workspace_roots/**/.env` uses `**`. Non-macOS sandboxing does not support unbounded `**` natively; set `glob_scan_max_depth` in this filesystem profile to cap Linux glob expansion and silence this warning, or enumerate explicit depths such as `*.env`, `*/*.env`, and `*/*/*.env`.";
    const prelude = [START[0], ...[1, 2].map((id) => ({ type: "item.completed", item: { id: `warning-${id}`, type: "error", message: warning } })), START[1]];
    const failure = jsonl([...prelude, { type: "turn.failed", error: { message: "unexpected status 502 Bad Gateway: unavailable" } }]);
    const { runner, children } = harness([{ stdout: failure, code: 1 }, { stdout: jsonl([...START, ...FINISH]), code: 0 }]);
    const observed = observe(runner.runWithDetails!("Classify"));
    await vi.advanceTimersByTimeAsync(1300);
    expect(await observed).toMatchObject({ value: { diagnostics: { attemptCount: 2, upstreamStatus: 502 } } });
    expect(children).toHaveLength(2);
  });

  it("stops after three failed invocations within the shared deadline", async () => {
    vi.useFakeTimers();
    const { runner, children } = harness(Array.from({ length: 4 }, () => ({ stdout: terminal(), code: 1 })));
    const observed = observe(runner.runWithDetails!("Classify"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(await observed).toMatchObject({ error: { code: "NON_ZERO_EXIT", diagnostics: { attemptCount: 3, upstreamStatus: 503 } } });
    expect(children).toHaveLength(3);
  });

  it.each([
    ["unknown exit", "", undefined],
    ["malformed capture", `${terminal()}\n{`, undefined],
    ["late permanent error", `${terminal()}\n${JSON.stringify({ type: "error", message: "authentication failed" })}`, undefined],
    ["mixed stderr", terminal(), "ERROR: authentication failed"],
    ["unknown stderr", terminal(), "fatal: unknown permanent failure"],
    ["generated transient text", jsonl([...START, { type: "item.completed", item: { id: "answer", type: "agent_message", text: "unexpected status 503 Service Unavailable: fake" } }]), undefined],
    ["malformed item lifecycle", jsonl([...START, { type: "item.updated", item: { id: "tool", type: "web_search" } }, { type: "turn.failed", error: { message: "unexpected status 503 Service Unavailable: unavailable" } }]), undefined],
  ])("does not retry %s", async (_name, stdout, stderr) => {
    const { runner, children } = harness([{ stdout: stdout!, stderr, code: 1 }]);
    await expect(runner.runWithDetails!("Classify")).rejects.toMatchObject({ code: "NON_ZERO_EXIT" });
    expect(children).toHaveLength(1);
  });

  it("does not retry a truncated capture even if its retained prefix is transient", async () => {
    const { runner, children } = harness([{ stdout: terminal(), code: 1, stderr: "x".repeat(2000) }], { maxOutputBytes: 1000 });
    await expect(runner.runWithDetails!("Classify")).rejects.toMatchObject({ diagnostics: { captureComplete: false } });
    expect(children).toHaveLength(1);
  });

  it("preserves the original CLI cause when cleanup fails and blocks retry", async () => {
    const { runner, children } = harness([{ stdout: terminal(), code: 1 }], {
      requestWorkspaceFactory: async () => ({ path: "C:/request", cleanup: async () => { throw new Error("secret cleanup path"); } }),
      requestWorkspaceCleanupDelay: async () => undefined,
    });
    await expect(runner.runWithDetails!("Classify")).rejects.toMatchObject({ code: "CLEANUP_FAILED", diagnostics: { attemptCount: 1, originalRunnerCode: "NON_ZERO_EXIT", upstreamStatus: 503, failureCategory: "cleanup_failed" } });
    expect(children).toHaveLength(1);
  });

  it("does not start a second child after the deadline expires during backoff", async () => {
    vi.useFakeTimers();
    const { runner, children } = harness([{ stdout: terminal(), code: 1 }], { timeoutMs: 500 });
    const observed = observe(runner.runWithDetails!("Classify"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(await observed).toMatchObject({ error: { code: "TIMEOUT" } });
    expect(children).toHaveLength(1);
  });

  it("cancels the backoff without starting another child", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { runner, children } = harness([{ stdout: terminal(), code: 1 }]);
    const observed = observe(runner.runWithDetails!("Classify", { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await observed).toMatchObject({ error: { code: "CANCELLED" } });
    expect(children).toHaveLength(1);
  });

  it("gives the second child only the deadline left after the first attempt and backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { runner, children, lifecycle } = harness([{ stdout: terminal(), code: 1, delayMs: 400 }, { stdout: "", code: 0, hang: true }], { timeoutMs: 1500 });
    const observed = observe(runner.runWithDetails!("Classify"));
    await vi.advanceTimersByTimeAsync(1600);
    expect(await observed).toMatchObject({ error: { code: "TIMEOUT", diagnostics: { attemptCount: 2, elapsedMs: 1500 } } });
    expect(children).toHaveLength(2);
    expect(children[1].kill).toHaveBeenCalledWith("SIGTERM");
    expect(lifecycle).toEqual(["spawn", "cleanup", "spawn", "cleanup"]);
  });

  it("does not spawn if workspace setup consumes the whole budget", async () => {
    vi.useFakeTimers();
    const { runner, children } = harness([], {
      timeoutMs: 100,
      requestWorkspaceFactory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { path: "C:/request", cleanup: async () => undefined };
      },
    });
    const observed = observe(runner.runWithDetails!("Classify"));
    await vi.advanceTimersByTimeAsync(250);
    expect(await observed).toMatchObject({ error: { code: "TIMEOUT" } });
    expect(children).toHaveLength(0);
  });

  it("does not retry if cleanup consumes the remaining budget", async () => {
    vi.useFakeTimers();
    const { runner, children } = harness([{ stdout: terminal(), code: 1 }], {
      timeoutMs: 100,
      requestWorkspaceFactory: async () => ({ path: "C:/request", cleanup: async () => { await new Promise((resolve) => setTimeout(resolve, 200)); } }),
    });
    const observed = observe(runner.runWithDetails!("Classify"));
    await vi.advanceTimersByTimeAsync(250);
    expect(await observed).toMatchObject({ error: { code: "TIMEOUT" } });
    expect(children).toHaveLength(1);
  });

  it("sanitizes a workspace setup failure and never retries it", async () => {
    const { runner, children } = harness([], { requestWorkspaceFactory: async () => { throw new Error("secret setup path"); } });
    await expect(runner.runWithDetails!("Classify")).rejects.toMatchObject({ code: "SPAWN_ERROR", message: "Codex request setup failed.", diagnostics: { failureCategory: "startup_failed" } });
    expect(children).toHaveLength(0);
  });

  it("honors cancellation that arrives while the failed attempt is being cleaned", async () => {
    const controller = new AbortController();
    let started!: () => void;
    let release!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { started = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
    const { runner, children } = harness([{ stdout: terminal(), code: 1 }], { requestWorkspaceFactory: async () => ({ path: "C:/request", cleanup: async () => { started(); await cleanupGate; } }) });
    const observed = observe(runner.runWithDetails!("Classify", { signal: controller.signal }));
    await cleanupStarted;
    controller.abort();
    release();
    expect(await observed).toMatchObject({ error: { code: "CANCELLED" } });
    expect(children).toHaveLength(1);
  });
});
