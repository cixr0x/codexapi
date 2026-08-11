import { lstat, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

  it("rejects missing, non-directory, and symlinked bases before creating a child", async () => {
    const base = await createBase();
    const root = join(base, "..");
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
