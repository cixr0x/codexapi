# Structured Output Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support Responses API `text.format` structured outputs for the local Codex-backed wrapper.

**Architecture:** Keep request prompt construction in `src/openaiCompat.ts`, move structured-output parsing and schema validation into a focused `src/structuredOutput.ts`, and call validation from `src/server.ts` after Codex returns. Tests drive the prompt, parser, validator, and route behavior.

**Tech Stack:** Node.js, TypeScript, Fastify, Vitest.

---

## File Structure

- `src/structuredOutput.ts`: parse requested response formats, build prompt instructions, extract JSON, validate JSON Schema subset, and normalize output text.
- `src/openaiCompat.ts`: append structured-output prompt instructions to Responses prompts.
- `src/server.ts`: normalize Codex output according to requested Responses format before creating the response object.
- `test/structuredOutput.test.ts`: parser, extraction, validation, and normalization tests.
- `test/openaiCompat.test.ts`: Responses prompt tests for `json_schema`, `json_object`, and unsupported formats.
- `test/server.test.ts`: route-level tests for normalized structured output and invalid output errors.
- `README.md`: note supported structured output formats and validation limits.

## Task 1: Structured Output Core

**Files:**
- Create: `src/structuredOutput.ts`
- Create: `test/structuredOutput.test.ts`

- [ ] **Step 1: Write failing tests**

Tests cover `json_schema` format parsing, JSON extraction from surrounding text, valid schema normalization, `additionalProperties: false`, missing required fields, and `json_object` object validation.

- [ ] **Step 2: Run tests and verify red**

Run: `npm test -- test/structuredOutput.test.ts`

Expected: FAIL because `src/structuredOutput.ts` does not exist.

- [ ] **Step 3: Implement minimal core**

Implement:

- `getResponseTextFormat(body)`
- `buildStructuredOutputInstructions(format)`
- `normalizeStructuredOutput(content, format)`
- `StructuredOutputError`

- [ ] **Step 4: Run tests and verify green**

Run: `npm test -- test/structuredOutput.test.ts`

Expected: PASS.

## Task 2: Prompt and Route Integration

**Files:**
- Modify: `src/openaiCompat.ts`
- Modify: `src/server.ts`
- Modify: `test/openaiCompat.test.ts`
- Modify: `test/server.test.ts`

- [ ] **Step 1: Write failing integration tests**

Tests cover Responses prompts containing schema instructions, unsupported formats returning `400`, route output text normalized to minified JSON, and invalid runner output returning `500 invalid_structured_output`.

- [ ] **Step 2: Run tests and verify red**

Run: `npm test -- test/openaiCompat.test.ts test/server.test.ts`

Expected: FAIL because integration is not implemented.

- [ ] **Step 3: Implement integration**

Append structured-output instructions in `buildResponsesPrompt()`, normalize runner output in `/v1/responses`, and map `StructuredOutputError` to OpenAI-style error JSON.

- [ ] **Step 4: Run tests and verify green**

Run: `npm test -- test/openaiCompat.test.ts test/server.test.ts`

Expected: PASS.

## Task 3: Documentation and Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document structured output support**

Document `json_schema`, `json_object`, and validation limits.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all commands exit `0`.

- [ ] **Step 3: Commit and push**

Run:

```bash
git add src test README.md docs/superpowers/plans/2026-06-24-structured-output.md
git commit -m "feat: support responses structured output"
git push
```

- [ ] **Step 4: Restart API and smoke test**

Restart the running API on port `3001`, then test `/v1/responses` with a `text.format.type: "json_schema"` request and verify `output_text` is valid JSON.

