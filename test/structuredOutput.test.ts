import { describe, expect, it } from "vitest";

import {
  StructuredOutputError,
  buildStructuredOutputInstructions,
  getResponseTextFormat,
  normalizeStructuredOutput,
} from "../src/structuredOutput.js";

const translationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    translatedText: { type: "string" },
    alternates: {
      type: "array",
      items: { type: "string" },
    },
    metadata: {
      type: "object",
      additionalProperties: false,
      properties: {
        confidence: { type: "number" },
        notes: { type: "string" },
        preserved_identity_terms: {
          type: "array",
          items: { type: "string" },
        },
        removed_noise: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: [
        "confidence",
        "notes",
        "preserved_identity_terms",
        "removed_noise",
      ],
    },
  },
  required: ["translatedText", "alternates", "metadata"],
};

describe("structured output", () => {
  it("parses Responses json_schema format", () => {
    const format = getResponseTextFormat({
      text: {
        format: {
          type: "json_schema",
          name: "translation_result",
          strict: true,
          schema: translationSchema,
        },
      },
    });

    expect(format).toEqual({
      type: "json_schema",
      name: "translation_result",
      strict: true,
      schema: translationSchema,
    });
  });

  it("returns null when Responses format is text or absent", () => {
    expect(getResponseTextFormat({ input: "Hello" })).toBeNull();
    expect(getResponseTextFormat({ text: { format: { type: "text" } } })).toBeNull();
  });

  it("rejects unsupported Responses format types", () => {
    expect(() =>
      getResponseTextFormat({ text: { format: { type: "grammar" } } }),
    ).toThrow(StructuredOutputError);
  });

  it("builds schema instructions for the Codex prompt", () => {
    const instructions = buildStructuredOutputInstructions({
      type: "json_schema",
      name: "translation_result",
      strict: true,
      schema: translationSchema,
    });

    expect(instructions).toContain("Return only valid JSON");
    expect(instructions).toContain("Do not wrap the JSON in Markdown fences");
    expect(instructions).toContain("Format name: translation_result");
    expect(instructions).toContain('"translatedText"');
    expect(instructions).toContain('"strict":true');
  });

  it("extracts and minifies a valid schema-matching JSON object", () => {
    const output = normalizeStructuredOutput(
      [
        "Here is the result:",
        JSON.stringify({
          translatedText: "Hola",
          alternates: ["Buenas"],
          metadata: {
            confidence: 0.91,
            notes: "direct translation",
            preserved_identity_terms: [],
            removed_noise: ["um"],
          },
        }),
      ].join("\n"),
      {
        type: "json_schema",
        name: "translation_result",
        strict: true,
        schema: translationSchema,
      },
    );

    expect(output).toBe(
      JSON.stringify({
        translatedText: "Hola",
        alternates: ["Buenas"],
        metadata: {
          confidence: 0.91,
          notes: "direct translation",
          preserved_identity_terms: [],
          removed_noise: ["um"],
        },
      }),
    );
  });

  it("rejects missing required schema fields", () => {
    expect(() =>
      normalizeStructuredOutput(
        JSON.stringify({
          translatedText: "Hola",
          alternates: [],
        }),
        {
          type: "json_schema",
          name: "translation_result",
          strict: true,
          schema: translationSchema,
        },
      ),
    ).toThrow(/metadata/);
  });

  it("rejects additional properties when schema forbids them", () => {
    expect(() =>
      normalizeStructuredOutput(
        JSON.stringify({
          translatedText: "Hola",
          alternates: [],
          extra: true,
          metadata: {
            confidence: 0.91,
            notes: "direct translation",
            preserved_identity_terms: [],
            removed_noise: [],
          },
        }),
        {
          type: "json_schema",
          name: "translation_result",
          strict: true,
          schema: translationSchema,
        },
      ),
    ).toThrow(/extra/);
  });

  it("validates JSON Schema enum and numeric constraints", () => {
    const format = {
      type: "json_schema" as const,
      name: "rating",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", enum: ["good", "bad"] },
          score: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["label", "score"],
      },
    };

    expect(() =>
      normalizeStructuredOutput('{"label":"other","score":2}', format),
    ).toThrow(StructuredOutputError);
  });

  it("rejects invalid JSON Schemas before invoking Codex", () => {
    expect(() =>
      getResponseTextFormat({
        text: {
          format: {
            type: "json_schema",
            name: "broken",
            strict: true,
            schema: { type: "not-a-json-schema-type" },
          },
        },
      }),
    ).toThrow(/valid JSON Schema/);
  });

  it("normalizes json_object output and rejects arrays", () => {
    expect(
      normalizeStructuredOutput("prefix {\"ok\":true} suffix", {
        type: "json_object",
      }),
    ).toBe("{\"ok\":true}");

    expect(() =>
      normalizeStructuredOutput("[1,2,3]", { type: "json_object" }),
    ).toThrow(StructuredOutputError);
  });
});
