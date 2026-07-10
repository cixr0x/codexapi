import { randomUUID } from "node:crypto";

import type { CodexUsage } from "./codexRunner.js";
import {
  buildStructuredOutputInstructions,
  getResponseTextFormat,
  type ResponseTextFormat,
} from "./structuredOutput.js";

type JsonRecord = Record<string, unknown>;

export type OpenAIErrorType =
  | "invalid_request_error"
  | "api_error"
  | "server_error";

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType;
    param: string | null;
    code: string | null;
  };
}

export class OpenAIHttpError extends Error {
  readonly statusCode: number;
  readonly body: OpenAIErrorBody;

  constructor(body: OpenAIErrorBody, statusCode = 400) {
    super(body.error.message);
    this.name = "OpenAIHttpError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export function openAiError(
  message: string,
  type: OpenAIErrorType = "invalid_request_error",
  param: string | null = null,
  code: string | null = null,
  statusCode = 400,
): OpenAIHttpError {
  return new OpenAIHttpError(
    {
      error: {
        message,
        type,
        param,
        code,
      },
    },
    statusCode,
  );
}

export function buildChatPrompt(body: unknown): string {
  const request = requireRecord(body, "Request body must be a JSON object.");
  rejectStreaming(request);

  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw openAiError(
      "Chat completion requests require a non-empty messages array.",
      "invalid_request_error",
      "messages",
      "invalid_messages",
    );
  }

  const lines = messages.map((message, index) => {
    const record = requireRecord(
      message,
      `messages[${index}] must be a JSON object.`,
      "messages",
    );
    const role = record.role;
    if (typeof role !== "string" || role.trim() === "") {
      throw openAiError(
        `messages[${index}].role must be a non-empty string.`,
        "invalid_request_error",
        "messages",
        "invalid_message_role",
      );
    }

    return `${role}: ${formatContent(record.content)}`;
  });

  lines.push("assistant:");
  return lines.join("\n");
}

export function buildResponsesPrompt(body: unknown): string {
  const request = requireRecord(body, "Request body must be a JSON object.");
  rejectStreaming(request);

  if (!Object.prototype.hasOwnProperty.call(request, "input")) {
    throw openAiError(
      "Responses requests require input.",
      "invalid_request_error",
      "input",
      "missing_input",
    );
  }

  const lines: string[] = [];
  if (typeof request.instructions === "string" && request.instructions !== "") {
    lines.push(`instructions: ${request.instructions}`);
  }

  lines.push(...formatResponseInput(request.input));
  const format = getResponseTextFormat(request);
  if (format) {
    lines.push(buildStructuredOutputInstructions(format));
  }

  return lines.join("\n");
}

export function createChatCompletion({
  model,
  content,
  usage,
}: {
  model: string;
  content: string;
  usage?: CodexUsage;
}) {
  const normalizedUsage = normalizeUsage(usage);
  return {
    id: prefixedId("chatcmpl"),
    object: "chat.completion",
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: normalizedUsage.inputTokens,
      completion_tokens: normalizedUsage.outputTokens,
      total_tokens: normalizedUsage.inputTokens + normalizedUsage.outputTokens,
      prompt_tokens_details: {
        cached_tokens: normalizedUsage.cachedInputTokens,
      },
      completion_tokens_details: {
        reasoning_tokens: normalizedUsage.reasoningOutputTokens,
      },
    },
  };
}

export function createResponse({
  model,
  content,
  reasoningEffort,
  textFormat = { type: "text" },
  usage,
}: {
  model: string;
  content: string;
  reasoningEffort?: string;
  textFormat?: ResponseTextFormat | { type: "text" };
  usage?: CodexUsage;
}) {
  const completedAt = nowSeconds();
  const normalizedUsage = normalizeUsage(usage);
  return {
    id: prefixedId("resp"),
    object: "response",
    created_at: completedAt,
    model,
    status: "completed",
    completed_at: completedAt,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    output_text: content,
    output: [
      {
        id: prefixedId("msg"),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: content,
            annotations: [],
          },
        ],
      },
    ],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: {
      effort: reasoningEffort ?? null,
      summary: null,
    },
    store: false,
    text: { format: textFormat },
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
    usage: {
      input_tokens: normalizedUsage.inputTokens,
      input_tokens_details: {
        cached_tokens: normalizedUsage.cachedInputTokens,
      },
      output_tokens: normalizedUsage.outputTokens,
      output_tokens_details: {
        reasoning_tokens: normalizedUsage.reasoningOutputTokens,
      },
      total_tokens: normalizedUsage.inputTokens + normalizedUsage.outputTokens,
    },
    metadata: {},
  };
}

function normalizeUsage(usage: CodexUsage | undefined): CodexUsage {
  return (
    usage ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    }
  );
}

function rejectStreaming(request: JsonRecord): void {
  if (request.stream === true) {
    throw openAiError(
      "Streaming is not supported by this local Codex API.",
      "invalid_request_error",
      "stream",
      "unsupported_streaming",
    );
  }
}

function formatResponseInput(input: unknown): string[] {
  if (typeof input === "string") {
    return [`input: ${input}`];
  }

  if (!Array.isArray(input)) {
    return [`input: ${formatContent(input)}`];
  }

  return input.map((item, index) => {
    if (typeof item === "string") {
      return `input: ${item}`;
    }

    const record = requireRecord(
      item,
      `input[${index}] must be a string or JSON object.`,
      "input",
    );
    const content = formatContent(record.content ?? record.text ?? record);
    return typeof record.role === "string" && record.role !== ""
      ? `${record.role}: ${content}`
      : content;
  });
}

function formatContent(content: unknown): string {
  if (content == null) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (typeof content === "number" || typeof content === "boolean") {
    return String(content);
  }

  if (Array.isArray(content)) {
    return content.map(formatContentPart).filter(Boolean).join("\n");
  }

  if (isRecord(content)) {
    if (typeof content.text === "string") {
      return content.text;
    }
    return JSON.stringify(content);
  }

  return String(content);
}

function formatContentPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }

  if (!isRecord(part)) {
    return formatContent(part);
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  if (typeof part.content === "string") {
    return part.content;
  }

  if (typeof part.type === "string") {
    return `[${part.type}]`;
  }

  return JSON.stringify(part);
}

function requireRecord(
  value: unknown,
  message: string,
  param: string | null = null,
): JsonRecord {
  if (!isRecord(value)) {
    throw openAiError(message, "invalid_request_error", param, "invalid_json");
  }

  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
