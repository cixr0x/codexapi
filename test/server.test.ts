import { describe, expect, it, vi } from "vitest";

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

function testConfig() {
  return {
    host: "127.0.0.1",
    port: 3000,
    codexWorkspace: "C:/workspace",
    codexCommand: "codex",
    codexCommandArgs: [],
    codexProfile: "plain",
    codexTimeoutMs: 120000,
    openAICompatModel: "local-codex-test",
  };
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
    expect(response.json()).toEqual({ status: "ok" });
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
        {
          id: "local-codex-test",
          object: "model",
          owned_by: "local",
        },
      ],
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
        model: "ignored-client-model",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith("user: Hello\nassistant:");
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "local-codex-test",
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
        model: "ignored-client-model",
        instructions: "Be concise.",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith("instructions: Be concise.\ninput: Hello");
    expect(response.json()).toMatchObject({
      object: "response",
      model: "local-codex-test",
      status: "completed",
      output_text: "Response from Codex",
    });
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
        model: "local-codex-test",
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
        model: "local-codex-test",
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
        model: "local-codex-test",
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
        model: "local-codex-test",
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
        model: "local-codex-test",
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
