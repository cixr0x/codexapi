import { randomUUID } from "node:crypto";

import {
  buildStructuredOutputInstructions,
  getResponseTextFormat,
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
}: {
  model: string;
  content: string;
}) {
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
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function createResponse({
  model,
  content,
}: {
  model: string;
  content: string;
}) {
  return {
    id: prefixedId("resp"),
    object: "response",
    created_at: nowSeconds(),
    model,
    status: "completed",
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
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
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
