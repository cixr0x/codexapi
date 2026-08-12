import { lstat, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fsPromises = vi.hoisted(() => ({ rm: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsPromises.rm.mockImplementation(actual.rm);
  return { ...actual, rm: fsPromises.rm };
});

import { createRequestWorkspace } from "../src/requestWorkspace.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createBase(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codexapi-request-workspace-test-"));
  temporaryRoots.push(root);
  const base = join(root, "base");
  await mkdir(base);
  return base;
}

describe("request workspace", () => {
  it("creates a contained opaque tagged canary child", async () => {
    const base = await createBase();
    const workspace = await createRequestWorkspace(base, "canary-0123456789abcdef0123456789abcdef");
    expect(basename(workspace.path)).toMatch(/^codexapi-request-canary-[a-f0-9]{32}-/);
    await workspace.cleanup();
  });

  it("rejects an unsafe request workspace tag", async () => {
    await expect(createRequestWorkspace(await createBase(), "../secret")).rejects.toThrow("tag is invalid");
  });

  it("creates unique children under the attested base and removes them idempotently", async () => {
    const base = await createBase();

    const first = await createRequestWorkspace(base);
    const second = await createRequestWorkspace(base);

    expect(first.path).not.toBe(second.path);
    expect(relative(base, first.path)).not.toMatch(/^\.\./u);
    expect((await lstat(first.path)).isDirectory()).toBe(true);

    await first.cleanup();
    await expect(stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    await first.cleanup();
    await second.cleanup();
  });

  it("allows cleanup to retry after the first removal fails", async () => {
    const base = await createBase();
    const workspace = await createRequestWorkspace(base);
    const failure = new Error("temporary removal failure");
    const callsBeforeCleanup = fsPromises.rm.mock.calls.length;
    fsPromises.rm.mockRejectedValueOnce(failure);

    await expect(workspace.cleanup()).rejects.toBe(failure);
    await expect(stat(workspace.path)).resolves.toBeDefined();

    await workspace.cleanup();
    expect(fsPromises.rm).toHaveBeenCalledTimes(callsBeforeCleanup + 2);
    await expect(stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares one in-flight removal between concurrent cleanup callers", async () => {
    const base = await createBase();
    const workspace = await createRequestWorkspace(base);
    const actualRemove = fsPromises.rm.getMockImplementation();
    if (!actualRemove) {
      throw new Error("Expected the filesystem removal implementation.");
    }
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const callsBeforeCleanup = fsPromises.rm.mock.calls.length;
    fsPromises.rm.mockImplementationOnce((...args: Parameters<typeof rm>) =>
      removalGate.then(() => actualRemove(...args)),
    );

    const first = workspace.cleanup();
    const second = workspace.cleanup();
    expect(fsPromises.rm).toHaveBeenCalledTimes(callsBeforeCleanup + 1);
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseRemoval();
    await Promise.all([first, second]);

    await expect(stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing, non-directory, and symlinked bases before creating a child", async () => {
    const base = await createBase();
    const missing = join(base, "missing");
    const file = join(base, "not-a-directory");
    const linked = join(base, "linked-base");
    await writeFile(file, "not a directory", "utf8");
    await symlink(base, linked, "junction");

    for (const candidate of [missing, file, linked]) {
      const before = await readdir(base);
      await expect(createRequestWorkspace(candidate)).rejects.toThrow();
      expect(await readdir(base)).toEqual(before);
    }
  });
});
