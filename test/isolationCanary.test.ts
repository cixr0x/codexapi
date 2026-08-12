import { describe, expect, it, vi } from "vitest";
import { IsolationCanaryError, runIsolationCanary, type IsolationCanaryDependencies } from "../src/isolationCanary.js";
import { isolationCanaryWorkspaceTag } from "../src/isolationCanaryCorrelation.js";

const FIRST_DIRECTORY = "/opt/ludora/ludora-admin/.codexapi-isolation-canary-a";
const FIRST_MARKER = `${FIRST_DIRECTORY}/marker`;
const MARKER_ROOTS = ["/opt/ludora/ludora-admin", "/opt/ludora/codexapi", "/var/lib/codexapi/home", "/root", "/home", "/home/robertorojas87"];

describe("runIsolationCanary", () => {
  it("attests an initially root-owned marker after fchown, fchmod, and fsync mutate it", async () => {
    const test = createHarness();
    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({ status: "ok", isolation: "verified" });
    for (const root of MARKER_ROOTS) expect(test.prompt()).toContain(`${root}/.codexapi-isolation-canary-`);
    expect(test.markerHandles[0]?.stat).toHaveBeenCalledTimes(2);
    expect(test.markerHandles[0]?.chown).toHaveBeenCalledWith(123, 456);
    expect(test.markerHandles[0]?.chmod).toHaveBeenCalledWith(0o400);
    expect(test.remove).toHaveBeenCalledWith(FIRST_MARKER);
    expect(test.removeDirectory).toHaveBeenCalledWith(FIRST_DIRECTORY);
  });

  it.each([
    ["root account", { account: { uid: 0, gid: 456 } }],
    ["root group", { account: { uid: 123, gid: 0 } }],
    ["unsafe account id", { account: { uid: Number.MAX_SAFE_INTEGER + 1, gid: 456 } }],
    ["wrong owner", { noOpChown: true }],
    ["wrong group", { chownGid: 999 }],
    ["wrong mode", { noOpChmod: true }],
  ])("fails closed for %s and never starts a hostile request", async (_name, options) => {
    const test = createHarness(options);
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.fetch).not.toHaveBeenCalledWith("http://127.0.0.1:3001/v1/responses", expect.anything());
  });

  it.each(["write", "chown", "chmod", "sync", "finalFstat"] as const)("cleans the exact initial marker and directory when %s setup fails", async (failAt) => {
    const test = createHarness({ failAt });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.markerHandles[0]?.close).toHaveBeenCalled();
    expect(test.remove).toHaveBeenCalledWith(FIRST_MARKER);
    expect(test.removeDirectory).toHaveBeenCalledWith(FIRST_DIRECTORY);
  });

  it.each(["marker", "hardlink", "directory"] as const)("preserves %s drift after partial setup failure", async (replacement) => {
    const test = createHarness({ failAt: "write", replacement });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.remove).not.toHaveBeenCalledWith(FIRST_MARKER);
    expect(test.removeDirectory).not.toHaveBeenCalledWith(FIRST_DIRECTORY);
  });

  it("aggregates persistent close failure while cleaning independent prepared markers", async () => {
    const test = createHarness({ persistentCloseFailure: true });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.markerHandles[0]?.close).toHaveBeenCalledTimes(4);
    expect(test.remove).toHaveBeenCalledTimes(MARKER_ROOTS.length - 1);
    expect(test.remove).not.toHaveBeenCalledWith(FIRST_MARKER);
  });

  it.each([
    ["missing output_text", createResponse(undefined)],
    ["malformed output_text", createResponse("not json")],
    ["access obtained", createResponse(JSON.stringify({ filesystem: "ACCESS_DENIED", network: "ACCESS_OBTAINED", write: "ACCESS_DENIED" }))],
  ])("preserves the hostile response envelope failure behavior for %s", async (_name, hostileResponse) => {
    await expect(runIsolationCanary(createHarness({ hostileResponse }).dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
  });

  it.each([
    ["access assessment", { hostileResponse: createResponse(JSON.stringify({ filesystem: "ACCESS_OBTAINED", network: "ACCESS_DENIED", write: "ACCESS_DENIED" })) }],
    ["private-server hit", { privateHits: 1 }],
    ["outside write", { outsideExists: true }],
  ])("runs and settles cancellation cleanup after a hostile %s failure", async (_name, options) => {
    const test = createHarness(options);
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.cancellationAborted).toBe(true);
    expect(test.requestSettled).toBe(true);
    expect(test.baselineWaitCalls).toBeGreaterThan(0);
  });

  it("waits for delayed AbortError settlement and workspace restoration after a scan throws", async () => {
    const test = createHarness({ workspaceScanFailsAfterStart: true, delayedAbort: true });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.cancellationAborted).toBe(true);
    expect(test.requestSettled).toBe(true);
    expect(test.baselineWaitCalls).toBeGreaterThan(0);
  });

  it("still waits for workspace restoration when cancellation classification fails", async () => {
    const test = createHarness({ cancellationRejects: true });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.requestSettled).toBe(true);
    expect(test.baselineWaitCalls).toBeGreaterThan(0);
  });

  it("fails closed for a hostile request timeout while cleaning prepared markers", async () => {
    const test = createHarness({ hostileHangs: true });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.remove).toHaveBeenCalledTimes(MARKER_ROOTS.length);
  });

  it("allows the normal 120-second runner lifecycle plus a small bounded margin", async () => {
    const test = createHarness({ hostileNeedsNormalRunnerLifecycle: true });

    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({ status: "ok", isolation: "verified" });
  });

  it("refuses non-Linux or non-root execution before creating a marker", async () => {
    const test = createHarness({ platform: "win32" });
    await expect(runIsolationCanary(test.dependencies)).rejects.toMatchObject({ message: "Isolation verification requires Linux root." });
    expect(test.makeDirectory).not.toHaveBeenCalled();
  });
});

type FailurePoint = "write" | "chown" | "chmod" | "sync" | "finalFstat";
type HarnessOptions = {
  platform?: NodeJS.Platform; account?: { uid: number; gid: number }; noOpChown?: boolean; noOpChmod?: boolean; chownGid?: number;
  failAt?: FailurePoint; replacement?: "marker" | "hardlink" | "directory"; persistentCloseFailure?: boolean;
  hostileResponse?: Response; hostileHangs?: boolean; privateHits?: number; outsideExists?: boolean;
  hostileNeedsNormalRunnerLifecycle?: boolean;
  workspaceScanFailsAfterStart?: boolean; delayedAbort?: boolean; cancellationRejects?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
  const names = ["a", "b", "c", "d", "e", "f", "outside"];
  const secrets = ["a", "b", "c", "d", "e", "f", "private"];
  const markerHandles: ReturnType<typeof createHandle>[] = [];
  const markerStates: MarkerState[] = [];
  const makeDirectory = vi.fn(async () => undefined);
  const removeDirectory = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  let readIndex = 0;
  let cancellationAborted = false;
  let requestSettled = false;
  let baselineWaitCalls = 0;
  let resolveHostileResponse: ((response: Response) => void) | undefined;
  const directoryInspections = new Map<string, number>();
  const snapshots = [[], [], [taggedChild()], []];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (String(init?.body).includes("extensive public-web")) {
      return new Promise<Response>((resolve, reject) => init?.signal?.addEventListener("abort", () => {
        cancellationAborted = true;
        const settle = () => { requestSettled = true; options.cancellationRejects ? reject(new Error("network failure")) : reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
        options.delayedAbort ? setTimeout(settle, 0) : settle();
      }, { once: true }));
    }
    if (options.hostileHangs) return new Promise<Response>(() => undefined);
    if (options.hostileNeedsNormalRunnerLifecycle) {
      return new Promise<Response>((resolve) => { resolveHostileResponse = resolve; });
    }
    return options.hostileResponse ?? createResponse(allDenied());
  });
  const dependencies: IsolationCanaryDependencies = {
    platform: options.platform ?? "linux", getuid: () => 0,
    randomToken: () => names.shift() ?? "next", randomSecret: () => secrets.shift() ?? "secret", randomUuid: () => "123e4567-e89b-42d3-a456-426614174000",
    makeDirectory, removeDirectory,
    openMarker: async () => {
      const state: MarkerState = { ino: markerStates.length + 1, uid: 0, gid: 0, mode: 0o600, nlink: 1 };
      markerStates.push(state);
      const handle = createHandle(state, options, markerHandles.length); markerHandles.push(handle); return handle;
    },
    inspectDirectory: async (path) => {
      const count = directoryInspections.get(path) ?? 0; directoryInspections.set(path, count + 1);
      return { dev: 1, ino: options.replacement === "directory" && path === FIRST_DIRECTORY && count > 0 ? 99 : Number(path.length), isDirectory: true, uid: 0, gid: 0, mode: 0o711 };
    },
    inspectMarker: async (path) => {
      const state = markerStates[markerIndex(path)] ?? markerStates[0]!;
      return { dev: 1, ino: options.replacement === "marker" && path === FIRST_MARKER ? 99 : state.ino, isFile: true, nlink: options.replacement === "hardlink" && path === FIRST_MARKER ? 2 : state.nlink, uid: state.uid, gid: state.gid, mode: state.mode };
    },
    remove, exists: async () => options.outsideExists ?? false,
    readDir: async () => {
      if (readIndex > 1) baselineWaitCalls += 1;
      if (options.workspaceScanFailsAfterStart && readIndex === 1) { readIndex += 1; throw new Error("scan failed"); }
      return snapshots[Math.min(readIndex++, snapshots.length - 1)] ?? [];
    },
    lookupServiceAccount: async () => options.account ?? { uid: 123, gid: 456 },
    startPrivateServer: async () => ({ url: "http://127.0.0.1:43123/private", getHits: () => options.privateHits ?? 0, close: async () => undefined, destroySockets: () => undefined }),
    fetch, sleep: async (delay) => {
      if (options.hostileNeedsNormalRunnerLifecycle) {
        if (delay > 120_000 && delay <= 130_000) {
          queueMicrotask(() => resolveHostileResponse?.(createResponse(allDenied())));
          return new Promise<void>(() => undefined);
        }
        if (delay !== 8_000) return;
      }
      if (delay === 8_000 && !options.hostileHangs) return new Promise<void>(() => undefined);
    },
  };
  return { dependencies, markerHandles, makeDirectory, removeDirectory, remove, fetch, prompt: () => JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).input[0].content[0].text as string, get cancellationAborted() { return cancellationAborted; }, get requestSettled() { return requestSettled; }, get baselineWaitCalls() { return baselineWaitCalls; } };
}

interface MarkerState { ino: number; uid: number; gid: number; mode: number; nlink: number; }
function createHandle(state: MarkerState, options: HarnessOptions, index: number) {
  let statCalls = 0;
  const fail = (point: FailurePoint) => { if (options.failAt === point) throw new Error(`${point} failed`); };
  return {
    writeFile: vi.fn(async () => fail("write")),
    chown: vi.fn(async (uid: number, gid: number) => { fail("chown"); if (!options.noOpChown) { state.uid = uid; state.gid = options.chownGid ?? gid; } }),
    chmod: vi.fn(async (mode: number) => { fail("chmod"); if (!options.noOpChmod) state.mode = mode; }),
    sync: vi.fn(async () => fail("sync")),
    stat: vi.fn(async () => { statCalls += 1; if (statCalls === 2) fail("finalFstat"); return { dev: 1, ino: state.ino, nlink: state.nlink, uid: state.uid, gid: state.gid, mode: state.mode, isFile: () => true }; }),
    close: vi.fn(async () => { if (options.persistentCloseFailure && index === 0) throw new Error("close failed"); }),
  };
}

function markerIndex(path: string) { const token = path.match(/canary-([a-f])/u)?.[1]; return token ? "abcdef".indexOf(token) : 0; }
function taggedChild() { return `codexapi-request-${isolationCanaryWorkspaceTag("123e4567-e89b-42d3-a456-426614174000", "127.0.0.1")}-random`; }
function allDenied() { return JSON.stringify({ filesystem: "ACCESS_DENIED", network: "ACCESS_DENIED", write: "ACCESS_DENIED" }); }
function createResponse(outputText: string | undefined): Response {
  const body: Record<string, unknown> = { output: outputText === undefined ? [] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: outputText }] }] };
  if (outputText !== undefined) body.output_text = outputText;
  return { ok: true, text: async () => JSON.stringify(body) } as Response;
}
