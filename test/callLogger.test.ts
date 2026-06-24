import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createCallLogger } from "../src/callLogger.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codexapi-logs-"));
  tempDirs.push(dir);
  return dir;
}

describe("call logger", () => {
  it("writes JSONL call entries when enabled", async () => {
    const dir = await tempDir();
    const logger = createCallLogger({ enabled: true, logDir: dir });

    await logger.log({
      id: "call_123",
      timestamp: "2026-06-24T00:00:00.000Z",
      endpoint: "/v1/responses",
      method: "POST",
      model: "local-codex",
      requestBody: { input: "Hello" },
      prompt: "input: Hello",
      rawStdout: "OK",
      rawStderr: "skill loaded",
      outputText: "OK",
      durationMs: 12,
      statusCode: 200,
    });

    const content = await readFile(join(dir, "calls.jsonl"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(content)).toMatchObject({
      id: "call_123",
      endpoint: "/v1/responses",
      rawStderr: "skill loaded",
      statusCode: 200,
    });
  });

  it("does not create a log file when disabled", async () => {
    const dir = await tempDir();
    const logger = createCallLogger({ enabled: false, logDir: dir });

    await logger.log({
      id: "call_123",
      timestamp: "2026-06-24T00:00:00.000Z",
      endpoint: "/v1/responses",
      method: "POST",
      model: "local-codex",
      requestBody: {},
      durationMs: 1,
      statusCode: 200,
    });

    await expect(readFile(join(dir, "calls.jsonl"), "utf8")).rejects.toThrow();
  });
});
