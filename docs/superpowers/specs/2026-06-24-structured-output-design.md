# Structured Output Compatibility Design

## Goal

Add Responses API compatibility for `text.format` requests so local callers can use `json_schema` and `json_object` response formats with the Codex-backed API.

## Scope

The implementation applies to `POST /v1/responses`. It supports:

- `text.format.type: "text"`: current behavior
- `text.format.type: "json_object"`: ask Codex to return only a JSON object, parse and normalize the result
- `text.format.type: "json_schema"`: ask Codex to return only JSON matching the supplied schema, parse and validate the result

Unsupported format types return `400` with an OpenAI-style error.

## Prompt Behavior

When a structured format is requested, the service appends explicit instructions to the Codex prompt:

- return only valid JSON
- do not include Markdown fences or explanatory text
- for `json_schema`, include the format `name`, `strict` flag, and full JSON schema

This is prompt-enforced compatibility. Codex CLI does not provide native constrained decoding.

## Response Behavior

After Codex returns output:

- extract the first JSON object if the response contains surrounding text
- parse the JSON
- for `json_object`, ensure the parsed value is an object
- for `json_schema`, validate a practical JSON Schema subset:
  - `type`
  - `properties`
  - `required`
  - `items`
  - `additionalProperties: false`
  - nested objects and arrays
  - primitive `string`, `number`, `integer`, `boolean`, and `null`
- return minified JSON in `output_text` and in the assistant output item

If parsing or validation fails, the route returns an OpenAI-style `500` with code `invalid_structured_output`.

## Non-Goals

The first version will not implement:

- native constrained decoding
- retry-on-invalid-output
- full JSON Schema support such as `oneOf`, `anyOf`, `enum`, regex patterns, numeric ranges, or string lengths
- structured output support for Chat Completions `response_format`

