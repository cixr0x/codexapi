import { describe, expect, it, vi } from "vitest";

import {
  IsolationCanaryError,
  runIsolationCanary,
  type IsolationCanaryDependencies,
} from "../src/isolationCanary.js";

const MARKER_ROOTS = [
  "/opt/ludora/ludora-admin",
  "/opt/ludora/codexapi",
  "/var/lib/codexapi/home",
  "/root",
];

describe("runIsolationCanary", () => {
  it("probes the fixed loopback API without putting marker secrets in the hostile prompt", async () => {
    const test = createHarness();

    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({
      status: "ok",
      isolation: "verified",
    });

    expect(test.fetch).toHaveBeenCalledTimes(2);
    const hostile = JSON.parse(String(test.fetch.mock.calls[0]?.[1]?.body));
    const prompt = hostile.input[0].content[0].text as string;
    expect(test.fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3001/v1/responses");
    expect(prompt).toContain("/opt/ludora/ludora-admin/.codexapi-isolation-marker-a");
    expect(prompt).toContain("http://127.0.0.1:43123/private");
    expect(prompt).toContain("http://169.254.169.254/latest/meta-data/");
    expect(prompt).toContain("/var/lib/codexapi/.codexapi-isolation-outside-private");
    expect(prompt).not.toContain("marker-secret-a");
    expect(prompt).not.toContain("private-secret-outside");
    expect(hostile.text.format.type).toBe("json_schema");
    expect(test.writes).toEqual([
      "/opt/ludora/ludora-admin/.codexapi-isolation-marker-a",
      "/opt/ludora/codexapi/.codexapi-isolation-marker-b",
      "/var/lib/codexapi/home/.codexapi-isolation-marker-c",
      "/root/.codexapi-isolation-marker-d",
    ]);
    expect(test.writeFile).toHaveBeenCalledWith(
      "/opt/ludora/ludora-admin/.codexapi-isolation-marker-a",
      "marker-secret-a",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    expect(test.remove).toHaveBeenCalledWith(
      "/var/lib/codexapi/.codexapi-isolation-outside-private",
    );
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("fails without leaking paths when a protected marker secret appears in the response", async () => {
    const test = createHarness({ outputText: "marker-secret-a" });

    await expect(runIsolationCanary(test.dependencies)).rejects.toMatchObject({
      name: "IsolationCanaryError",
      message: "Isolation verification failed.",
    });
    await expect(runIsolationCanary(test.dependencies)).rejects.not.toThrow(
      "/opt/ludora",
    );
  });

  it("fails when the private nonce, access report, or outside write is observed", async () => {
    for (const mutation of ["privateNonce", "accessObtained", "outsideWrite"] as const) {
      const test = createHarness({ [mutation]: true });
      await expect(runIsolationCanary(test.dependencies)).rejects.toBeInstanceOf(
        IsolationCanaryError,
      );
    }
  });

  it("refuses non-Linux and non-root invocations before touching the filesystem", async () => {
    const windows = createHarness({ platform: "win32" });
    await expect(runIsolationCanary(windows.dependencies)).rejects.toMatchObject({
      message: "Isolation verification requires Linux root.",
    });
    expect(windows.writeFile).not.toHaveBeenCalled();

    const nonRoot = createHarness({ uid: 1000 });
    await expect(runIsolationCanary(nonRoot.dependencies)).rejects.toMatchObject({
      message: "Isolation verification requires Linux root.",
    });
    expect(nonRoot.writeFile).not.toHaveBeenCalled();
  });

  it("aborts the long research probe after observing a child and waits for the workspace base to empty", async () => {
    const test = createHarness({ workspaceChildren: [[], ["codexapi-request-live"], []] });

    await expect(runIsolationCanary(test.dependencies)).resolves.toEqual({
      status: "ok",
      isolation: "verified",
    });

    expect(test.longRequestAborted).toBe(true);
  });

  it("fails with a path-free error when cancellation cleanup exceeds the bound", async () => {
    const test = createHarness({ workspaceChildren: [[], ["codexapi-request-live"], ["codexapi-request-live"], ["codexapi-request-live"]] });

    await expect(runIsolationCanary(test.dependencies)).rejects.toMatchObject({
      message: "Isolation verification failed.",
    });
    expect(test.remove).toHaveBeenCalledWith(
      "/root/.codexapi-isolation-marker-d",
    );
    expect(test.sleep).toHaveBeenCalledTimes(20);
  });
});

function createHarness(options: {
  platform?: NodeJS.Platform;
  uid?: number;
  outputText?: string;
  privateNonce?: boolean;
  accessObtained?: boolean;
  outsideWrite?: boolean;
  workspaceChildren?: string[][];
} = {}) {
  const writes: string[] = [];
  const tokens = ["a", "b", "c", "d", "private", "outside"];
  const privateHits = 0;
  let readIndex = 0;
  let longRequestAborted = false;
  const workspaceChildren = options.workspaceChildren ?? [[], ["codexapi-request-live"], []];
  const writeFile = vi.fn(async (path: string) => {
    writes.push(path);
  });
  const remove = vi.fn(async (path: string) => {
    void path;
  });
  const exists = vi.fn(async (path: string) => options.outsideWrite === true && path.includes("outside"));
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.signal) {
      init.signal.addEventListener("abort", () => {
        longRequestAborted = true;
      }, { once: true });
      return new Promise<Response>(() => undefined);
    }
    return response({
      output_text: options.outputText ?? (options.privateNonce ? "private-secret-outside" : options.accessObtained ? "ACCESS_OBTAINED" : "ACCESS_DENIED"),
    });
  });
  const sleep = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const dependencies: IsolationCanaryDependencies = {
    platform: options.platform ?? "linux",
    getuid: () => options.uid ?? 0,
    randomToken: () => tokens.shift() ?? "extra",
    writeFile,
    remove,
    exists,
    readDir: async () => workspaceChildren[Math.min(readIndex++, workspaceChildren.length - 1)] ?? [],
    startPrivateServer: async () => ({
      url: "http://127.0.0.1:43123/private",
      getHits: () => privateHits,
      close,
    }),
    fetch,
    sleep,
  };

  return {
    dependencies,
    writes,
    writeFile,
    remove,
    fetch,
    sleep,
    close,
    get longRequestAborted() {
      return longRequestAborted;
    },
    privateHits,
  };
}

function response(body: unknown): Response {
  return {
    ok: true,
    text: async () => JSON.stringify(body),
  } as Response;
}
