import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexRunnerError, type CodexRunner } from "../src/codexRunner.js";
import { createServer, isMainModule } from "../src/server.js";

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    translatedText: { type: "string" },
    alternates: { type: "array", items: { type: "string" } },
  },
  required: ["translatedText", "alternates"],
};

function fakeRunner(output = "Codex output") {
  const run = vi.fn<CodexRunner["run"]>(async () => output);
  return { runner: { run }, run };
}

function fakeDetailedRunner(stdout = "Codex output", stderr = "skill loaded") {
  const run = vi.fn<CodexRunner["run"]>(async () => stdout);
  const runWithDetails = vi.fn<NonNullable<CodexRunner["runWithDetails"]>>(async () => ({
    stdout,
    rawStdout: "raw codex events",
    stderr,
    usage: {
      inputTokens: 21,
      cachedInputTokens: 8,
      outputTokens: 5,
      reasoningOutputTokens: 2,
    },
    command: {
      executable: "codex",
      args: [
        "exec",
        "input: Hello",
        "--skip-git-repo-check",
        "--sandbox",
        "danger-full-access",
        "--dangerously-bypass-approvals-and-sandbox",
        "--profile",
        "plain",
      ],
      cwd: "C:/workspace",
      shell: false as const,
    },
  }));
  return { runner: { run, runWithDetails }, run, runWithDetails };
}

function testConfig() {
  return {
    host: "127.0.0.1",
    port: 3001,
    codexBackend: "exec" as const,
    codexWorkspace: "C:/workspace",
    codexHome: "C:/codex-home",
    codexTimeoutMs: 120000,
    codexDefaultModel: "gpt-5.4-mini",
    codexAllowedModels: ["gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol"],
    codexReasoningEffort: "medium" as const,
    callLoggingEnabled: false,
    callLogDir: "C:/workspace/.codexapi/logs",
  };
}

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

it("fails closed when direct config bypasses safe workspace loading", () => {
  expect(() => createServer({ config: testConfig() })).toThrow(
    "CODEX_WORKSPACE must exist as an empty directory.",
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codexapi-server-logs-"));
  tempDirs.push(dir);
  return dir;
}

describe("Fastify server", () => {
  it("detects the entrypoint from a Windows argv path", () => {
    expect(
      isMainModule(
        "file:///C:/PROJECTS/codexapi/dist/server.js",
        "C:\\PROJECTS\\codexapi\\dist\\server.js",
      ),
    ).toBe(true);
  });

  it("returns health status", async () => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      executionPolicy: {
        backend: "exec",
        sandbox: "read-only",
        approvalPolicy: "never",
        mcpServers: "disabled",
      },
    });
    expect(response.body).not.toContain("C:/workspace");
    expect(response.body).not.toContain("C:/codex-home");
    await app.close();
  });

  it("serves a same-origin web interface for testing Codex API calls", async () => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Codex API Tester");
    expect(response.body).toContain("/v1/responses");
    expect(response.body).toContain("/v1/chat/completions");
    expect(response.body).toContain("json_schema");
    await app.close();
  });

  it("returns 400 when chat completion model is not allowlisted", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Hello from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "local-codex",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(runWithDetails).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message: "Model 'local-codex' is not allowed by this local Codex API.",
        type: "invalid_request_error",
        param: "model",
        code: "invalid_model",
      },
    });
    await app.close();
  });

  it("passes the chat completion request model and default reasoning effort to Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Hello from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("user: Hello\nassistant:", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      webSearch: false,
      imagePaths: [],
    });
    await app.close();
  });

  it("returns an OpenAI-style model list", async () => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({ method: "GET", url: "/v1/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      data: [
        { id: "gpt-5.4-mini", object: "model", owned_by: "local" },
        { id: "gpt-5.5", object: "model", owned_by: "local" },
        { id: "gpt-5.6-sol", object: "model", owned_by: "local" },
      ],
    });
    await app.close();
  });

  it("passes the Responses request model and default reasoning effort to Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.5",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("input: Hello", {
      model: "gpt-5.5",
      reasoningEffort: "medium",
      webSearch: false,
      imagePaths: [],
    });
    await app.close();
  });

  it("passes the supported Responses web search capability to Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.5",
        input: "Find the current documentation.",
        tools: [{ type: "web_search" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("input: Find the current documentation.", {
      model: "gpt-5.5",
      reasoningEffort: "medium",
      webSearch: true,
      imagePaths: [],
    });
    await app.close();
  });

  it.each([
    [
      "unsupported Responses tools",
      "/v1/responses",
      { input: "Hello", tools: [{ type: "function", name: "lookup" }] },
      "tools",
    ],
    [
      "unsupported Responses tool choice",
      "/v1/responses",
      { input: "Hello", tools: [{ type: "web_search" }], tool_choice: "required" },
      "tool_choice",
    ],
    [
      "Responses tool choice without tools",
      "/v1/responses",
      { input: "Hello", tool_choice: "required" },
      "tool_choice",
    ],
    [
      "Responses tool choice with empty tools",
      "/v1/responses",
      { input: "Hello", tools: [], tool_choice: "required" },
      "tool_choice",
    ],
    [
      "chat tools",
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "Hello" }], tools: [{ type: "web_search" }] },
      "tools",
    ],
    [
      "chat tool choice",
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "Hello" }], tool_choice: "auto" },
      "tool_choice",
    ],
  ])("returns 400 before invoking Codex for %s", async (_name, url, payload, param) => {
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url,
      payload: { model: "gpt-5.4-mini", ...payload },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { type: "invalid_request_error", param } });
    expect(runWithDetails).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [
      "chat",
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "Hello" }] },
      "https://user:secret@example.test/x",
    ],
    [
      "Responses",
      "/v1/responses",
      { input: "Hello" },
      "C:\\temp\\unvalidated-model.json",
    ],
  ])("does not log an unvalidated model identifier after %s validation fails", async (
    _name,
    url,
    payload,
    unvalidatedModel,
  ) => {
    const logDir = await tempDir();
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({
      config: { ...testConfig(), callLoggingEnabled: true, callLogDir: logDir },
      runner,
    });

    const response = await app.inject({
      method: "POST",
      url,
      payload: { ...payload, model: unvalidatedModel },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { type: "invalid_request_error", param: "model" },
    });
    expect(runWithDetails).not.toHaveBeenCalled();

    const logContent = await readFile(join(logDir, "calls.jsonl"), "utf8");
    expect(JSON.parse(logContent)).not.toHaveProperty("model");
    expect(logContent).not.toContain(unvalidatedModel);
    await app.close();
  });

  it("honors request-level reasoning effort for both compatibility endpoints", async () => {
    const chat = fakeDetailedRunner("Chat response");
    const chatApp = createServer({ config: testConfig(), runner: chat.runner });
    const chatResponse = await chatApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(chatResponse.statusCode).toBe(200);
    expect(chat.runWithDetails).toHaveBeenCalledWith("user: Hello\nassistant:", {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      webSearch: false,
      imagePaths: [],
    });
    await chatApp.close();

    const responses = fakeDetailedRunner("Response");
    const responsesApp = createServer({
      config: testConfig(),
      runner: responses.runner,
    });
    const responsesResponse = await responsesApp.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.6-sol",
        reasoning: { effort: "max" },
        input: "Hello",
      },
    });

    expect(responsesResponse.statusCode).toBe(200);
    expect(responses.runWithDetails).toHaveBeenCalledWith("input: Hello", {
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      webSearch: false,
      imagePaths: [],
    });
    expect(responsesResponse.json()).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "max", summary: null },
    });
    await responsesApp.close();
  });

  it("rejects unsupported request reasoning effort before invoking Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.6-sol",
        reasoning: { effort: "maximum" },
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(runWithDetails).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message:
          "reasoning.effort must be one of: low, medium, high, xhigh, max, ultra.",
        type: "invalid_request_error",
        param: "reasoning.effort",
        code: "invalid_reasoning_effort",
      },
    });
    await app.close();
  });

  it("returns 400 when Responses model is not allowlisted", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "local-codex",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(runWithDetails).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message: "Model 'local-codex' is not allowed by this local Codex API.",
        type: "invalid_request_error",
        param: "model",
        code: "invalid_model",
      },
    });
    await app.close();
  });

  it("falls back to the default Codex model when Responses model is absent", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("input: Hello", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      webSearch: false,
      imagePaths: [],
    });
    await app.close();
  });

  it("maps chat completions to a codex prompt and returns chat completion JSON", async () => {
    const { runner, run } = fakeRunner("Hello from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith("user: Hello\nassistant:");
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "gpt-5.4-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello from Codex" },
          finish_reason: "stop",
        },
      ],
    });
    await app.close();
  });

  it("maps responses input to a codex prompt and returns response JSON", async () => {
    const { runner, run } = fakeRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        instructions: "Be concise.",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith("instructions: Be concise.\ninput: Hello");
    expect(response.json()).toMatchObject({
      object: "response",
      model: "gpt-5.4-mini",
      status: "completed",
      output_text: "Response from Codex",
    });
    await app.close();
  });

  it("logs response calls when API-level logging is enabled", async () => {
    const logDir = await tempDir();
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex", "skill log");
    const app = createServer({
      config: {
        ...testConfig(),
        callLoggingEnabled: true,
        callLogDir: logDir,
      },
      runner,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("input: Hello", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      webSearch: false,
      imagePaths: [],
    });

    const logContent = await readFile(join(logDir, "calls.jsonl"), "utf8");
    const entry = JSON.parse(logContent);
    expect(entry).toEqual({
      id: expect.stringMatching(/^call_/),
      timestamp: expect.any(String),
      endpoint: "/v1/responses",
      method: "POST",
      model: "gpt-5.4-mini",
      webSearchEnabled: false,
      imageDiagnosticCode: "none",
      durationMs: expect.any(Number),
      statusCode: 200,
    });
    expect(logContent).not.toContain("raw codex events");
    expect(logContent).not.toContain("C:/workspace");
    await app.close();
  });

  it("normalizes json_schema Responses output before returning it", async () => {
    const { runner, run } = fakeRunner(
      "Sure:\n{\"translatedText\":\"Hola\",\"alternates\":[\"Buenas\"]}",
    );
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        input: "Translate hello.",
        text: {
          format: {
            type: "json_schema",
            name: "translation_result",
            strict: true,
            schema: responseSchema,
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(run.mock.calls[0]?.[0]).toContain("Return only valid JSON");
    expect(response.json()).toMatchObject({
      object: "response",
      output_text: "{\"translatedText\":\"Hola\",\"alternates\":[\"Buenas\"]}",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: "{\"translatedText\":\"Hola\",\"alternates\":[\"Buenas\"]}",
            },
          ],
        },
      ],
    });
    await app.close();
  });

  it("returns an OpenAI-style error for invalid structured output", async () => {
    const { runner } = fakeRunner("{\"translatedText\":\"Hola\"}");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        input: "Translate hello.",
        text: {
          format: {
            type: "json_schema",
            name: "translation_result",
            strict: true,
            schema: responseSchema,
          },
        },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        message: "$.alternates is required.",
        type: "api_error",
        param: null,
        code: "invalid_structured_output",
      },
    });
    await app.close();
  });

  it("returns 400 for unsupported Responses text formats", async () => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        input: "Hello",
        text: { format: { type: "grammar" } },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "Unsupported response text format: grammar.",
        type: "invalid_request_error",
        param: "text.format.type",
        code: "unsupported_response_format",
      },
    });
    await app.close();
  });

  it.each([
    ["chat completions", "/v1/chat/completions", { messages: [{ role: "user", content: "Hi" }] }],
    ["responses", "/v1/responses", { input: "Hi" }],
  ])("rejects stream=true for %s", async (_name, url, payload) => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url,
      payload: {
        model: "gpt-5.4-mini",
        stream: true,
        ...payload,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "Streaming is not supported by this local Codex API.",
        type: "invalid_request_error",
        param: "stream",
        code: "unsupported_streaming",
      },
    });
    await app.close();
  });

  it("returns OpenAI-style errors when the runner fails", async () => {
    const runner: CodexRunner = {
      run: vi.fn(async () => {
        throw new CodexRunnerError({
          message: "Codex command exited with code 2.",
          code: "NON_ZERO_EXIT",
          exitCode: 2,
          stderr: "Bad prompt",
        });
      }),
    };
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        message: "Codex command exited with code 2. Bad prompt",
        type: "api_error",
        param: null,
        code: "codex_cli_error",
      },
    });
    await app.close();
  });
});
