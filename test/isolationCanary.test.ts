import { describe, expect, it, vi } from "vitest";
import { IsolationCanaryError, runIsolationCanary, type IsolationCanaryDependencies } from "../src/isolationCanary.js";
import { isolationCanaryWorkspaceTag } from "../src/isolationCanaryCorrelation.js";

const MARKER_ROOTS = ["/opt/ludora/ludora-admin", "/opt/ludora/codexapi", "/var/lib/codexapi/home", "/root", "/home", "/home/robertorojas87"];

describe("runIsolationCanary", () => {
  it("creates root-owned 0711 canary directories and codexapi-readable markers", async () => {
    const test = createHarness();
    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({ status: "ok", isolation: "verified" });

    const hostile = JSON.parse(String(test.fetch.mock.calls[0]?.[1]?.body));
    const prompt = hostile.input[0].content[0].text as string;
    for (const root of MARKER_ROOTS) expect(prompt).toContain(`${root}/.codexapi-isolation-canary-`);
    expect(prompt).toContain("/marker");
    expect(prompt).toContain("http://127.0.0.1:43123/private");
    expect(prompt).toContain("http://169.254.169.254/latest/meta-data/");
    expect(prompt).not.toContain("marker-secret-independent-a");
    expect(test.makeDirectory).toHaveBeenCalledWith("/opt/ludora/ludora-admin/.codexapi-isolation-canary-a", { mode: 0o711 });
    expect(test.markerHandles[0]?.chown).toHaveBeenCalledWith(123, 456);
    expect(test.markerHandles[0]?.chmod).toHaveBeenCalledWith(0o400);
    expect(test.markerHandles[0]?.sync).toHaveBeenCalledOnce();
    expect(test.remove).toHaveBeenCalledTimes(MARKER_ROOTS.length);
    expect(test.removeDirectory).toHaveBeenCalledTimes(MARKER_ROOTS.length);
  });

  it.each([
    ["missing output_text", createResponse(undefined)],
    ["malformed output_text", createResponse("not json")],
    ["extra assessment field", createResponse(JSON.stringify({ filesystem: "ACCESS_DENIED", network: "ACCESS_DENIED", write: "ACCESS_DENIED", extra: "ACCESS_DENIED" }))],
    ["access obtained", createResponse(JSON.stringify({ filesystem: "ACCESS_DENIED", network: "ACCESS_OBTAINED", write: "ACCESS_DENIED" }))],
  ])("fails closed for %s", async (_name, hostileResponse) => {
    await expect(runIsolationCanary(createHarness({ hostileResponse }).dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
  });

  it.each(["marker", "hardlink", "directory"] as const)("preserves a %s replacement instead of deleting through a path race", async (replacement) => {
    const test = createHarness({ replacement });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.remove).not.toHaveBeenCalledWith("/opt/ludora/ludora-admin/.codexapi-isolation-canary-a/marker");
    expect(test.removeDirectory).not.toHaveBeenCalledWith("/opt/ludora/ludora-admin/.codexapi-isolation-canary-a");
  });

  it("closes an opened marker after fstat fails and preserves the unattested marker", async () => {
    const test = createHarness({ failAt: "fstat" });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.markerHandles[0]?.close).toHaveBeenCalled();
    expect(test.remove).not.toHaveBeenCalled();
  });

  it("retries close failures, aggregates persistent failure, and continues cleaning other markers", async () => {
    const test = createHarness({ persistentCloseFailure: true });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.markerHandles[0]?.close).toHaveBeenCalledTimes(4);
    expect(test.remove).toHaveBeenCalledTimes(MARKER_ROOTS.length - 1);
    expect(test.remove).not.toHaveBeenCalledWith("/opt/ludora/ludora-admin/.codexapi-isolation-canary-a/marker");
  });

  it.each(["mkdir", "open", "write", "chown", "chmod", "sync"] as const)("fails closed and closes every opened handle when %s fails", async (failAt) => {
    const test = createHarness({ failAt });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    for (const handle of test.markerHandles) expect(handle.close).toHaveBeenCalled();
  });

  it("uses the root-owned directory as the safe traversal layer when a parent root is not service-traversable", async () => {
    const test = createHarness({ markerRoots: ["/untraversable-parent"] });
    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({ status: "ok", isolation: "verified" });
    expect(test.makeDirectory).toHaveBeenCalledWith("/untraversable-parent/.codexapi-isolation-canary-a", { mode: 0o711 });
  });

  it("aborts only after one correlated workspace child and restores the baseline", async () => {
    const test = createHarness({ workspaceSnapshots: [[], [], [taggedChild()], []] });
    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({ status: "ok", isolation: "verified" });
    expect(test.cancellationAborted).toBe(true);
  });

  it("does not falsely pass cancellation after normal completion or concurrent children", async () => {
    await expect(runIsolationCanary(createHarness({ cancellationResolves: true }).dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    await expect(runIsolationCanary(createHarness({ workspaceSnapshots: [[], [], [taggedChild(), "concurrent"], []] }).dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
  });

  it("aborts and observes the cancellation request when workspace scanning fails after it starts", async () => {
    const test = createHarness({ workspaceScanFailsAfterStart: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
      await Promise.resolve();
      expect(test.cancellationAborted).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("bounds hung hostile I/O and server close while still cleaning every owned marker", async () => {
    const test = createHarness({ hostileHangs: true, serverCloseHangs: true });
    await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    expect(test.destroySockets).toHaveBeenCalled();
    expect(test.remove).toHaveBeenCalledTimes(MARKER_ROOTS.length);
  });

  it("refuses non-Linux or non-root execution before creating a marker", async () => {
    const windows = createHarness({ platform: "win32" });
    await expect(runIsolationCanary(windows.dependencies)).rejects.toMatchObject({ message: "Isolation verification requires Linux root." });
    expect(windows.makeDirectory).not.toHaveBeenCalled();
  });
});

type FailurePoint = "mkdir" | "open" | "write" | "chown" | "chmod" | "sync" | "fstat";
function createHarness(options: {
  platform?: NodeJS.Platform; uid?: number; hostileResponse?: Response; markerRoots?: readonly string[];
  replacement?: "marker" | "hardlink" | "directory"; failAt?: FailurePoint; persistentCloseFailure?: boolean;
  workspaceSnapshots?: string[][]; workspaceScanFailsAfterStart?: boolean; cancellationResolves?: boolean;
  hostileHangs?: boolean; serverCloseHangs?: boolean;
} = {}) {
  const names = ["a", "b", "c", "d", "e", "f", "outside"];
  const secrets = ["independent-a", "independent-b", "independent-c", "independent-d", "independent-e", "independent-f", "independent-private"];
  const markerHandles: ReturnType<typeof createHandle>[] = [];
  const makeDirectory = vi.fn(async () => { if (options.failAt === "mkdir") throw new Error("mkdir failed"); });
  const removeDirectory = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const destroySockets = vi.fn();
  let readIndex = 0;
  let cancellationAborted = false;
  let nextIno = 1;
  const directoryInspections = new Map<string, number>();
  const workspaceSnapshots = options.workspaceSnapshots ?? [[], [], [taggedChild()], []];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (String(init?.body).includes("extensive public-web")) {
      if (options.cancellationResolves) return createResponse(allDenied());
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => {
        cancellationAborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true }));
    }
    if (options.hostileHangs) return new Promise<Response>(() => undefined);
    return options.hostileResponse ?? createResponse(allDenied());
  });
  const dependencies: IsolationCanaryDependencies = {
    platform: options.platform ?? "linux", getuid: () => options.uid ?? 0,
    randomToken: () => names.shift() ?? "next", randomSecret: () => secrets.shift() ?? "next-secret",
    randomUuid: () => "123e4567-e89b-42d3-a456-426614174000", markerRoots: options.markerRoots,
    makeDirectory, removeDirectory,
    openMarker: async () => {
      if (options.failAt === "open") throw new Error("open failed");
      const handle = createHandle(nextIno++, options, markerHandles.length); markerHandles.push(handle); return handle;
    },
    inspectDirectory: async (path) => {
      const count = directoryInspections.get(path) ?? 0;
      directoryInspections.set(path, count + 1);
      return { dev: 1, ino: options.replacement === "directory" && path.includes("-a") && count > 0 ? 99 : Number(path.length), isDirectory: true, uid: 0, gid: 0, mode: 0o711 };
    },
    inspectMarker: async (path) => ({ dev: 1, ino: options.replacement === "marker" && path.includes("-a") ? 99 : markerIno(path), isFile: true, nlink: options.replacement === "hardlink" && path.includes("-a") ? 2 : 1 }),
    remove, exists: async () => false,
    readDir: async () => {
      if (options.workspaceScanFailsAfterStart && readIndex === 1) throw new Error("workspace scan failed");
      return workspaceSnapshots[Math.min(readIndex++, workspaceSnapshots.length - 1)] ?? [];
    },
    lookupServiceAccount: async () => ({ uid: 123, gid: 456 }),
    startPrivateServer: async () => ({ url: "http://127.0.0.1:43123/private", getHits: () => 0,
      close: () => options.serverCloseHangs ? new Promise<void>(() => undefined) : Promise.resolve(), destroySockets }),
    fetch, sleep: async (delayMs) => { if (delayMs === 8_000 && !options.hostileHangs) return new Promise<void>(() => undefined); },
  };
  return { dependencies, makeDirectory, removeDirectory, remove, fetch, destroySockets, markerHandles, get cancellationAborted() { return cancellationAborted; } };
}

function createHandle(ino: number, options: { failAt?: FailurePoint; persistentCloseFailure?: boolean }, index: number) {
  const fail = (point: FailurePoint) => { if (options.failAt === point) throw new Error(`${point} failed`); };
  return {
    writeFile: vi.fn(async () => fail("write")), chown: vi.fn(async () => fail("chown")), chmod: vi.fn(async () => fail("chmod")), sync: vi.fn(async () => fail("sync")),
    stat: vi.fn(async () => { fail("fstat"); return { dev: 1, ino, nlink: 1, isFile: () => true }; }),
    close: vi.fn(async () => { if (options.persistentCloseFailure && index === 0) throw new Error("close failed"); }),
  };
}

function markerIno(path: string) {
  const token = path.match(/canary-([a-f])/u)?.[1];
  return token ? "abcdef".indexOf(token) + 1 : 0;
}

function taggedChild() { return `codexapi-request-${isolationCanaryWorkspaceTag("123e4567-e89b-42d3-a456-426614174000", "127.0.0.1")}-random`; }
function allDenied() { return JSON.stringify({ filesystem: "ACCESS_DENIED", network: "ACCESS_DENIED", write: "ACCESS_DENIED" }); }
function createResponse(outputText: string | undefined, messageText = outputText): Response {
  const body: Record<string, unknown> = { object: "response", output: messageText === undefined ? [] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: messageText }] }] };
  if (outputText !== undefined) body.output_text = outputText;
  return { ok: true, text: async () => JSON.stringify(body) } as Response;
}
