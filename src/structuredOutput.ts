type JsonRecord = Record<string, unknown>;

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
    validateAgainstSchema(parsed, format.schema, "$");
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

function validateAgainstSchema(value: unknown, schema: unknown, path: string): void {
  if (!isRecord(schema)) {
    return;
  }

  validateType(value, schema.type, path);

  if (schema.type === "object" || shouldTreatAsObjectSchema(schema)) {
    validateObject(value, schema, path);
  }

  if (schema.type === "array") {
    validateArray(value, schema, path);
  }
}

function validateObject(value: unknown, schema: JsonRecord, path: string): void {
  if (!isRecord(value)) {
    throw new StructuredOutputError(`${path} must be an object.`);
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];

  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new StructuredOutputError(`${path}.${key} is required.`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        throw new StructuredOutputError(`${path}.${key} is not allowed.`);
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      validateAgainstSchema(value[key], propertySchema, `${path}.${key}`);
    }
  }
}

function validateArray(value: unknown, schema: JsonRecord, path: string): void {
  if (!Array.isArray(value)) {
    throw new StructuredOutputError(`${path} must be an array.`);
  }

  if (schema.items === undefined) {
    return;
  }

  value.forEach((item, index) => {
    validateAgainstSchema(item, schema.items, `${path}[${index}]`);
  });
}

function validateType(value: unknown, type: unknown, path: string): void {
  if (type === undefined) {
    return;
  }

  const types = Array.isArray(type) ? type : [type];
  const valid = types.some((candidate) => matchesType(value, candidate));
  if (!valid) {
    throw new StructuredOutputError(
      `${path} must be ${types.map(String).join(" or ")}.`,
    );
  }
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function shouldTreatAsObjectSchema(schema: JsonRecord): boolean {
  return (
    isRecord(schema.properties) ||
    Array.isArray(schema.required) ||
    schema.additionalProperties === false
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
