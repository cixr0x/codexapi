import { describe, expect, it, vi } from "vitest";

import {
  IsolationCanaryError,
  runIsolationCanary,
  type IsolationCanaryDependencies,
} from "../src/isolationCanary.js";
import { isolationCanaryWorkspaceTag } from "../src/isolationCanaryCorrelation.js";

const MARKER_ROOTS = [
  "/opt/ludora/ludora-admin",
  "/opt/ludora/codexapi",
  "/var/lib/codexapi/home",
  "/root",
  "/home",
  "/home/robertorojas87",
];

describe("runIsolationCanary", () => {
  it("uses all fixed protected targets and accepts only the exact all-denied Responses assessment", async () => {
    const test = createHarness();

    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({
      status: "ok",
      isolation: "verified",
    });

    const hostile = JSON.parse(String(test.fetch.mock.calls[0]?.[1]?.body));
    const prompt = hostile.input[0].content[0].text as string;
    expect(test.fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3001/v1/responses");
    for (const root of MARKER_ROOTS) {
      expect(prompt).toContain(`${root}/.codexapi-isolation-marker-`);
    }
    expect(prompt).toContain("http://127.0.0.1:43123/private");
    expect(prompt).toContain("http://10.0.0.1/");
    expect(prompt).toContain("http://169.254.169.254/latest/meta-data/");
    expect(prompt).toContain("/var/lib/codexapi/.codexapi-isolation-outside-");
    expect(prompt).not.toContain("marker-secret-independent-a");
    expect(prompt).not.toContain("private-secret-independent");
    expect(hostile.text.format.type).toBe("json_schema");
    expect(test.writeFile).toHaveBeenCalledWith(
      "/opt/ludora/ludora-admin/.codexapi-isolation-marker-a",
      "marker-secret-independent-a",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    expect(test.chown).toHaveBeenCalledWith(
      "/opt/ludora/ludora-admin/.codexapi-isolation-marker-a",
      123,
      456,
    );
    expect(test.chmod).toHaveBeenCalledWith(
      "/opt/ludora/ludora-admin/.codexapi-isolation-marker-a",
      0o400,
    );
  });

  it.each([
    ["missing output_text", createResponse(undefined)],
    ["malformed output_text", createResponse("not json")],
    ["extra assessment field", createResponse(JSON.stringify({ filesystem: "ACCESS_DENIED", network: "ACCESS_DENIED", write: "ACCESS_DENIED", extra: "ACCESS_DENIED" }))],
    ["access obtained", createResponse(JSON.stringify({ filesystem: "ACCESS_DENIED", network: "ACCESS_OBTAINED", write: "ACCESS_DENIED" }))],
  ])("fails closed for %s", async (_name, hostileResponse) => {
    const test = createHarness({ hostileResponse });
    await expect(runIsolationCanary(test.dependencies)).rejects.toMatchObject({
      message: "Isolation verification failed.",
    });
  });

  it("fails for a secret in an assistant output message or a private-server hit without scanning schema metadata", async () => {
    const secretMessage = createResponse(allDenied(), "marker-secret-independent-a");
    await expect(runIsolationCanary(createHarness({ hostileResponse: secretMessage }).dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
    await expect(runIsolationCanary(createHarness({ privateHits: 1 }).dependencies)).rejects.toBeInstanceOf(IsolationCanaryError);
  });

  it("cleans partial markers if fixed account lookup fails and preserves replacement markers", async () => {
    const lookupFailure = createHarness({ lookupFails: true });
    await expect(runIsolationCanary(lookupFailure.dependencies)).rejects.toMatchObject({
      message: "Isolation verification failed.",
    });
    expect(lookupFailure.remove).toHaveBeenCalledWith(
      "/opt/ludora/ludora-admin/.codexapi-isolation-marker-a",
    );

    const replacement = createHarness({ replacementMarker: true });
    await expect(runIsolationCanary(replacement.dependencies)).rejects.toMatchObject({
      message: "Isolation verification failed.",
    });
    expect(replacement.remove).not.toHaveBeenCalledWith(
      "/opt/ludora/ludora-admin/.codexapi-isolation-marker-a",
    );
  });

  it("aborts only after one new workspace child, requires AbortError, and restores the empty baseline", async () => {
    const test = createHarness({ workspaceSnapshots: [[], [], [taggedChild()], []] });
    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({
      status: "ok",
      isolation: "verified",
    });
    expect(test.cancellationAborted).toBe(true);
  });

  it("preserves an existing baseline child while removing only the cancelled request child", async () => {
    const test = createHarness({ workspaceSnapshots: [["baseline"], ["baseline"], ["baseline", taggedChild()], ["baseline"]] });
    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({
      status: "ok",
      isolation: "verified",
    });
    expect(test.cancellationAborted).toBe(true);
  });

  it.each([
    ["normal completion", { cancellationResolves: true }],
    ["concurrent children", { workspaceSnapshots: [[], [], [taggedChild(), "concurrent"], []] }],
  ])("fails instead of falsely passing cancellation after %s", async (_name, options) => {
    await expect(runIsolationCanary(createHarness(options).dependencies)).rejects.toMatchObject({
      message: "Isolation verification failed.",
    });
  });

  it("bounds hung hostile I/O and server close while still cleaning every owned marker", async () => {
    const test = createHarness({ hostileHangs: true, serverCloseHangs: true });
    await expect(runIsolationCanary(test.dependencies)).rejects.toMatchObject({
      message: "Isolation verification failed.",
    });
    expect(test.destroySockets).toHaveBeenCalled();
    expect(test.remove).toHaveBeenCalledTimes(MARKER_ROOTS.length);
  });

  it("bounds a hostile response body that stalls after headers and cleans owned markers", async () => {
    const test = createHarness({ hostileBodyHangs: true });
    await expect(runIsolationCanary(test.dependencies)).rejects.toMatchObject({ message: "Isolation verification failed." });
    expect(test.remove).toHaveBeenCalledTimes(MARKER_ROOTS.length);
  });

  it("refuses non-Linux or non-root execution before creating a marker", async () => {
    const windows = createHarness({ platform: "win32" });
    await expect(runIsolationCanary(windows.dependencies)).rejects.toMatchObject({
      message: "Isolation verification requires Linux root.",
    });
    expect(windows.writeFile).not.toHaveBeenCalled();

    const nonRoot = createHarness({ uid: 1 });
    await expect(runIsolationCanary(nonRoot.dependencies)).rejects.toMatchObject({
      message: "Isolation verification requires Linux root.",
    });
    expect(nonRoot.writeFile).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  platform?: NodeJS.Platform;
  uid?: number;
  hostileResponse?: Response;
  privateHits?: number;
  lookupFails?: boolean;
  replacementMarker?: boolean;
  workspaceSnapshots?: string[][];
  cancellationResolves?: boolean;
  hostileHangs?: boolean;
  hostileBodyHangs?: boolean;
  serverCloseHangs?: boolean;
} = {}) {
  const names = ["a", "b", "c", "d", "e", "f", "outside"];
  const secrets = ["independent-a", "independent-b", "independent-c", "independent-d", "independent-e", "independent-f", "independent-private"];
  let readIndex = 0;
  let cancellationAborted = false;
  let nextIdentity = 1;
  const identities = new Map<string, number>();
  const workspaceSnapshots = options.workspaceSnapshots ?? [[], [], [taggedChild()], []];
  const writeFile = vi.fn(async () => undefined);
  const chown = vi.fn(async () => undefined);
  const chmod = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const destroySockets = vi.fn();
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (body.includes("extensive public-web")) {
      if (options.cancellationResolves) {
        return createResponse(allDenied());
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          cancellationAborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    }
    if (options.hostileHangs) {
      return new Promise<Response>(() => undefined);
    }
    if (options.hostileBodyHangs) return { ok: true, text: () => new Promise<string>(() => undefined) } as Response;
    return options.hostileResponse ?? createResponse(allDenied());
  });
  const dependencies: IsolationCanaryDependencies = {
    platform: options.platform ?? "linux",
    getuid: () => options.uid ?? 0,
    randomToken: () => names.shift() ?? "next",
    randomSecret: () => secrets.shift() ?? "next-secret",
    randomUuid: () => "123e4567-e89b-42d3-a456-426614174000",
    writeFile,
    chown,
    chmod,
    inspect: async (path) => {
      const existing = identities.get(path);
      if (existing === undefined) {
        const identity = nextIdentity++;
        identities.set(path, identity);
        return { dev: 1, ino: identity, isFile: true };
      }
      if (options.replacementMarker && path === "/opt/ludora/ludora-admin/.codexapi-isolation-marker-a") {
        return { dev: 1, ino: 99, isFile: true };
      }
      return { dev: 1, ino: existing, isFile: true };
    },
    remove,
    exists: async () => false,
    readDir: async () => workspaceSnapshots[Math.min(readIndex++, workspaceSnapshots.length - 1)] ?? [],
    lookupServiceAccount: async () => {
      if (options.lookupFails) throw new Error("lookup failed");
      return { uid: 123, gid: 456 };
    },
    startPrivateServer: async () => ({
      url: "http://127.0.0.1:43123/private",
      getHits: () => options.privateHits ?? 0,
      close: () => options.serverCloseHangs ? new Promise<void>(() => undefined) : Promise.resolve(),
      destroySockets,
    }),
    fetch,
    sleep: async (delayMs) => {
      if (delayMs === 8_000 && !options.hostileHangs) {
        return new Promise<void>(() => undefined);
      }
    },
  };
  return { dependencies, writeFile, chown, chmod, remove, fetch, destroySockets, get cancellationAborted() { return cancellationAborted; } };
}

function taggedChild(): string {
  return `codexapi-request-${isolationCanaryWorkspaceTag("123e4567-e89b-42d3-a456-426614174000", "127.0.0.1")}-random`;
}

function allDenied(): string {
  return JSON.stringify({ filesystem: "ACCESS_DENIED", network: "ACCESS_DENIED", write: "ACCESS_DENIED" });
}

function createResponse(outputText: string | undefined, messageText = outputText): Response {
  const body: Record<string, unknown> = {
    object: "response",
    output: messageText === undefined ? [] : [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: messageText }],
    }],
  };
  if (outputText !== undefined) body.output_text = outputText;
  return { ok: true, text: async () => JSON.stringify(body) } as Response;
}
