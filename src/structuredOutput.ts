import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

type JsonRecord = Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaValidators = new WeakMap<object, ValidateFunction>();

export type ResponseTextFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      name: string;
      strict: boolean;
      schema: unknown;
    };

export class StructuredOutputError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly param: string | null;

  constructor(
    message: string,
    {
      statusCode = 500,
      code = "invalid_structured_output",
      param = null,
    }: {
      statusCode?: number;
      code?: string;
      param?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "StructuredOutputError";
    this.statusCode = statusCode;
    this.code = code;
    this.param = param;
  }
}

export function getResponseTextFormat(body: unknown): ResponseTextFormat | null {
  if (!isRecord(body) || !isRecord(body.text) || !isRecord(body.text.format)) {
    return null;
  }

  const format = body.text.format;
  if (format.type === undefined || format.type === "text") {
    return null;
  }

  if (format.type === "json_object") {
    return { type: "json_object" };
  }

  if (format.type === "json_schema") {
    if (typeof format.name !== "string" || format.name.trim() === "") {
      throw new StructuredOutputError(
        "text.format.name must be a non-empty string for json_schema responses.",
        {
          statusCode: 400,
          code: "invalid_response_format",
          param: "text.format.name",
        },
      );
    }

    if (!isRecord(format.schema)) {
      throw new StructuredOutputError(
        "text.format.schema must be a JSON object for json_schema responses.",
        {
          statusCode: 400,
          code: "invalid_response_format",
          param: "text.format.schema",
        },
      );
    }

    getSchemaValidator(format.schema, {
      statusCode: 400,
      code: "invalid_response_format",
      param: "text.format.schema",
    });

    return {
      type: "json_schema",
      name: format.name,
      strict: format.strict === true,
      schema: format.schema,
    };
  }

  throw new StructuredOutputError(
    `Unsupported response text format: ${String(format.type)}.`,
    {
      statusCode: 400,
      code: "unsupported_response_format",
      param: "text.format.type",
    },
  );
}

export function buildStructuredOutputInstructions(format: ResponseTextFormat): string {
  if (format.type === "json_object") {
    return [
      "response_format:",
      "Return only valid JSON.",
      "Return a single JSON object.",
      "Do not wrap the JSON in Markdown fences.",
      "Do not include explanations, comments, or text outside the JSON object.",
    ].join("\n");
  }

  return [
    "response_format:",
    "Return only valid JSON.",
    "Return a single JSON object that matches the JSON Schema below.",
    "Do not wrap the JSON in Markdown fences.",
    "Do not include explanations, comments, or text outside the JSON object.",
    `Format name: ${format.name}`,
    `Format descriptor: ${JSON.stringify({
      type: "json_schema",
      name: format.name,
      strict: format.strict,
      schema: format.schema,
    })}`,
  ].join("\n");
}

export function normalizeStructuredOutput(
  content: string,
  format: ResponseTextFormat | null,
): string {
  if (format === null) {
    return content;
  }

  const parsed = parseExtractedJsonObject(content);
  if (!isRecord(parsed)) {
    throw new StructuredOutputError("Structured output must be a JSON object.");
  }

  if (format.type === "json_schema") {
    const validate = getSchemaValidator(format.schema);
    if (!validate(parsed)) {
      throw new StructuredOutputError(formatSchemaError(validate.errors));
    }
  }

  return JSON.stringify(parsed);
}

function parseExtractedJsonObject(content: string): unknown {
  const objectText = extractFirstJsonObject(content);
  if (!objectText) {
    throw new StructuredOutputError("Codex output did not contain a JSON object.");
  }

  try {
    return JSON.parse(objectText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid JSON.";
    throw new StructuredOutputError(`Codex output was not valid JSON: ${detail}`);
  }
}

function extractFirstJsonObject(content: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return null;
}

function getSchemaValidator(
  schema: unknown,
  errorOptions: {
    statusCode?: number;
    code?: string;
    param?: string | null;
  } = {},
): ValidateFunction {
  if (!isRecord(schema)) {
    throw new StructuredOutputError(
      "text.format.schema must be a valid JSON Schema object.",
      errorOptions,
    );
  }

  const cached = schemaValidators.get(schema);
  if (cached) {
    return cached;
  }

  try {
    const validate = ajv.compile(schema);
    schemaValidators.set(schema, validate);
    return validate;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid JSON Schema.";
    throw new StructuredOutputError(
      `text.format.schema must be a valid JSON Schema: ${detail}`,
      errorOptions,
    );
  }
}

function formatSchemaError(errors: ErrorObject[] | null | undefined): string {
  const error = errors?.[0];
  if (!error) {
    return "Structured output did not match the requested JSON Schema.";
  }

  const path = jsonPointerPath(error.instancePath);
  if (error.keyword === "required") {
    return `${appendPath(path, String(error.params.missingProperty))} is required.`;
  }

  if (error.keyword === "additionalProperties") {
    return `${appendPath(path, String(error.params.additionalProperty))} is not allowed.`;
  }

  const message = error.message ?? "is invalid";
  return `${path} ${message}${message.endsWith(".") ? "" : "."}`;
}

function jsonPointerPath(pointer: string): string {
  if (!pointer) {
    return "$";
  }

  return `$${pointer
    .split("/")
    .slice(1)
    .map((part) => `.${part.replaceAll("~1", "/").replaceAll("~0", "~")}`)
    .join("")}`;
}

function appendPath(path: string, property: string): string {
  return `${path}.${property}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
