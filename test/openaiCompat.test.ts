import { describe, expect, it } from "vitest";

import {
  OpenAIHttpError,
  buildChatPrompt,
  buildResponsesPrompt,
  createChatCompletion,
  createResponse,
} from "../src/openaiCompat.js";
import { StructuredOutputError } from "../src/structuredOutput.js";

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    translatedText: { type: "string" },
    alternates: { type: "array", items: { type: "string" } },
  },
  required: ["translatedText", "alternates"],
};

describe("OpenAI compatibility mapping", () => {
  it("converts chat messages into a role-labeled prompt ending with an assistant cue", () => {
    const prompt = buildChatPrompt({
      model: "local-codex",
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi." },
        { role: "user", content: [{ type: "text", text: "Summarize this." }] },
      ],
    });

    expect(prompt).toBe(
      [
        "system: You are concise.",
        "user: Hello",
        "assistant: Hi.",
        "user: Summarize this.",
        "assistant:",
      ].join("\n"),
    );
  });

  it("rejects streaming chat completion requests", () => {
    expect(() =>
      buildChatPrompt({
        model: "local-codex",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).toThrow(OpenAIHttpError);
  });

  it("uses string response input directly and prefixes instructions", () => {
    const prompt = buildResponsesPrompt({
      model: "local-codex",
      instructions: "Be brief.",
      input: "Write a haiku.",
    });

    expect(prompt).toBe("instructions: Be brief.\ninput: Write a haiku.");
  });

  it("normalizes array response input into readable text", () => {
    const prompt = buildResponsesPrompt({
      model: "local-codex",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "First line." },
            { type: "text", text: "Second line." },
          ],
        },
        { role: "assistant", content: "Prior answer." },
      ],
    });

    expect(prompt).toBe("user: First line.\nSecond line.\nassistant: Prior answer.");
  });

  it("adds json_schema response format instructions to Responses prompts", () => {
    const prompt = buildResponsesPrompt({
      model: "local-codex",
      input: "Translate hello.",
      text: {
        format: {
          type: "json_schema",
          name: "translation_result",
          strict: true,
          schema: responseSchema,
        },
      },
    });

    expect(prompt).toContain("input: Translate hello.");
    expect(prompt).toContain("response_format:");
    expect(prompt).toContain("Return only valid JSON");
    expect(prompt).toContain("Format name: translation_result");
    expect(prompt).toContain('"translatedText"');
  });

  it("adds json_object response format instructions to Responses prompts", () => {
    const prompt = buildResponsesPrompt({
      model: "local-codex",
      input: "Return JSON.",
      text: { format: { type: "json_object" } },
    });

    expect(prompt).toContain("Return a single JSON object.");
  });

  it("rejects unsupported Responses text formats", () => {
    expect(() =>
      buildResponsesPrompt({
        model: "local-codex",
        input: "Hello",
        text: { format: { type: "grammar" } },
      }),
    ).toThrow(StructuredOutputError);
  });

  it("rejects streaming responses requests", () => {
    expect(() =>
      buildResponsesPrompt({
        model: "local-codex",
        stream: true,
        input: "Hello",
      }),
    ).toThrow(OpenAIHttpError);
  });

  it("creates chat completion response objects with Codex usage", () => {
    const completion = createChatCompletion({
      model: "gpt-5.6-sol",
      content: "Codex output",
      usage: {
        inputTokens: 21,
        cachedInputTokens: 8,
        outputTokens: 5,
        reasoningOutputTokens: 2,
      },
    });

    expect(completion.object).toBe("chat.completion");
    expect(completion.model).toBe("gpt-5.6-sol");
    expect(completion.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "Codex output" },
        finish_reason: "stop",
      },
    ]);
    expect(completion.usage).toEqual({
      prompt_tokens: 21,
      completion_tokens: 5,
      total_tokens: 26,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
  });

  it("creates responses objects with output_text and assistant output item", () => {
    const response = createResponse({
      model: "gpt-5.6-sol",
      content: "Codex output",
      reasoningEffort: "high",
      textFormat: { type: "text" },
      usage: {
        inputTokens: 21,
        cachedInputTokens: 8,
        outputTokens: 5,
        reasoningOutputTokens: 2,
      },
    });

    expect(response.object).toBe("response");
    expect(response.model).toBe("gpt-5.6-sol");
    expect(response.status).toBe("completed");
    expect(response.completed_at).toEqual(expect.any(Number));
    expect(response.error).toBeNull();
    expect(response.incomplete_details).toBeNull();
    expect(response.reasoning).toEqual({ effort: "high", summary: null });
    expect(response.text).toEqual({ format: { type: "text" } });
    expect(response.output_text).toBe("Codex output");
    expect(response.output).toEqual([
      {
        id: expect.stringMatching(/^msg_/),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Codex output",
            annotations: [],
          },
        ],
      },
    ]);
    expect(response.usage).toEqual({
      input_tokens: 21,
      input_tokens_details: { cached_tokens: 8 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 26,
    });
  });
});
