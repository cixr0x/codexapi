import { randomUUID } from "node:crypto";

import type { CodexUsage } from "./codexRunner.js";
import {
  buildStructuredOutputInstructions,
  getResponseTextFormat,
  type ResponseTextFormat,
} from "./structuredOutput.js";

type JsonRecord = Record<string, unknown>;
type InputImagePart = JsonRecord & { type: "input_image" };

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
  rejectChatImageContent(request);
  rejectStreaming(request);
  rejectChatTools(request);

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
  return normalizeResponsesRequest(body).prompt;
}

export interface NormalizedResponsesRequest {
  prompt: string;
  imageUrl: string | null;
}

export function normalizeResponsesRequest(body: unknown): NormalizedResponsesRequest {
  const request = requireRecord(body, "Request body must be a JSON object.");
  const inputImage = validateResponsesInputImage(request);
  rejectStreaming(request);
  validateWebSearchDeclaration(request);

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

  const formattedInput = formatResponseInput(request.input, inputImage);
  for (const line of formattedInput.lines) {
    lines.push(line);
  }
  const format = getResponseTextFormat(request);
  if (format) {
    lines.push(buildStructuredOutputInstructions(format));
  }

  return {
    prompt: lines.join("\n"),
    imageUrl: formattedInput.imageUrl,
  };
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

function rejectChatTools(request: JsonRecord): void {
  if (request.tools !== undefined) {
    throw openAiError(
      "Chat completion tools are not supported.",
      "invalid_request_error",
      "tools",
    );
  }

  if (request.tool_choice !== undefined) {
    throw openAiError(
      "Chat completion tool_choice is not supported.",
      "invalid_request_error",
      "tool_choice",
    );
  }
}

function validateWebSearchDeclaration(body: JsonRecord): void {
  if (body.tool_choice !== undefined && body.tool_choice !== "auto") {
    throw openAiError(
      'tool_choice must be "auto".',
      "invalid_request_error",
      "tool_choice",
    );
  }

  if (body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0)) {
    return;
  }

  if (
    !Array.isArray(body.tools) ||
    body.tools.length !== 1 ||
    !isRecord(body.tools[0]) ||
    Object.keys(body.tools[0]).length !== 1 ||
    body.tools[0].type !== "web_search"
  ) {
    throw openAiError(
      "Only one web_search tool is supported.",
      "invalid_request_error",
      "tools",
    );
  }

}

function formatResponseInput(
  input: unknown,
  inputImage: InputImagePart | null,
): {
  lines: string[];
  imageUrl: string | null;
} {
  if (typeof input === "string") {
    return { lines: [`input: ${input}`], imageUrl: null };
  }

  if (!Array.isArray(input)) {
    return { lines: [`input: ${formatContent(input)}`], imageUrl: null };
  }

  const lines = input.map((item, index) => {
    if (typeof item === "string") {
      return `input: ${item}`;
    }

    const record = requireRecord(
      item,
      `input[${index}] must be a string or JSON object.`,
      "input",
    );
    const rawContent = record.content ?? record.text ?? record;
    const content = Array.isArray(record.content)
      ? record.content
          .map((part) => formatResponseContentPart(part, inputImage))
          .filter(Boolean)
          .join("\n")
      : formatContent(rawContent);
    return typeof record.role === "string" && record.role !== ""
      ? `${record.role}: ${content}`
      : content;
  });

  return {
    lines,
    imageUrl: inputImage === null ? null : (inputImage.image_url as string),
  };
}

function formatResponseContentPart(
  part: unknown,
  inputImage: InputImagePart | null,
): string {
  if (inputImage === null || part !== inputImage) {
    return formatContentPart(part);
  }

  return `[store cover attached when available]\nimage_url: ${inputImage.image_url as string}`;
}

function rejectChatImageContent(content: unknown): void {
  if (findInputImageOccurrences(content).length > 0) {
    throw openAiError(
      "Chat completion image inputs are not supported.",
      "invalid_request_error",
      "messages",
      "unsupported_chat_image",
    );
  }
}

function invalidInputImageError(): OpenAIHttpError {
  return openAiError(
    "input_image must appear in Responses message content and use a string image_url.",
    "invalid_request_error",
    "input",
    "invalid_input_image",
  );
}

function isInputImagePart(value: unknown): value is InputImagePart {
  return isRecord(value) && value.type === "input_image";
}

function validateResponsesInputImage(request: JsonRecord): InputImagePart | null {
  const occurrences = findInputImageOccurrences(request);
  const directParts = directResponsesInputImages(request.input);

  if (directParts.length > 1) {
    throw openAiError(
      "Responses requests support at most one input_image.",
      "invalid_request_error",
      "input",
      "multiple_input_images",
    );
  }
  if (occurrences.length === 0) {
    return null;
  }
  if (
    occurrences.length !== 1 ||
    directParts.length !== 1 ||
    occurrences[0] !== directParts[0]
  ) {
    throw invalidInputImageError();
  }

  const inputImage = directParts[0]!;
  if (
    typeof inputImage.image_url !== "string" ||
    Object.prototype.hasOwnProperty.call(inputImage, "file_id")
  ) {
    throw invalidInputImageError();
  }
  return inputImage;
}

function directResponsesInputImages(input: unknown): InputImagePart[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const images: InputImagePart[] = [];
  for (const item of input) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (isInputImagePart(part)) {
        images.push(part);
      }
    }
  }
  return images;
}

function findInputImageOccurrences(value: unknown): InputImagePart[] {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  const occurrences: InputImagePart[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (isInputImagePart(current)) {
      occurrences.push(current);
    }
    if (typeof current !== "object" || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) {
      pending.push(child);
    }
  }

  return occurrences;
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
