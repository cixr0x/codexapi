import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexRunnerError, type CodexRunner, type CodexRunnerErrorCode } from "../src/codexRunner.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const MODEL = "caller-selected-model";
const WORKSPACE = mkdtempSync(join(tmpdir(), "codexapi-model-workspace-"));
const CODEX_HOME = mkdtempSync(join(tmpdir(), "codexapi-model-home-"));
afterAll(() => {
  rmSync(WORKSPACE, { recursive: true, force: true });
  rmSync(CODEX_HOME, { recursive: true, force: true });
});
const UNSUPPORTED = `The '${MODEL}' model is not supported when using Codex with a ChatGPT account.`;
const UNAVAILABLE = `The model \`${MODEL}\` does not exist or you do not have access to it.`;
const UNSUPPORTED_ENVELOPE = {
  type: "error", status: 400,
  error: { type: "invalid_request_error", message: UNSUPPORTED },
};
const CODE_MODE_WARNING = `Code Mode is enabled in configuration, but model \`${MODEL}\` does not advertise Code Mode support. This may degrade model performance. Disable \`features.code_mode\` and \`features.code_mode_only\`, or select a model whose metadata enables Code Mode.`;
const endpoints = [
  ["/v1/responses", { input: "Hello" }],
  ["/v1/chat/completions", { messages: [{ role: "user", content: "Hello" }] }],
] as const;

function config() {
  return loadConfig({
    CODEX_WORKSPACE: WORKSPACE,
    CODEX_HOME,
    // These obsolete settings must not restrict or supply a request model.
    CODEX_DEFAULT_MODEL: "old-default",
    CODEX_ALLOWED_MODELS: MODEL,
  });
}

describe.each(endpoints)("required client model on %s", (url, payload) => {
  it.each([
    ["omitted", undefined], ["null", null], ["number", 42], ["boolean", true],
    ["object", {}], ["array", [MODEL]], ["empty", ""], ["whitespace", " \t\n "],
  ])("rejects %s model before executing Codex", async (_name, model) => {
    const runWithDetails = vi.fn<NonNullable<CodexRunner["runWithDetails"]>>(async () => ({ stdout: "Hello", stderr: "" }));
    const run = vi.fn(async () => "Hello");
    const prepareRemoteImage = vi.fn();
    const app = createServer({ config: config(), runner: { run, runWithDetails }, prepareRemoteImage });
    try {
      const response = await app.inject({ method: "POST", url, payload: { ...payload, ...(model === undefined ? {} : { model }) } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { type: "invalid_request_error", param: "model", code: "invalid_model" } });
      expect(response.json().error.message).toContain("non-empty string");
      expect(runWithDetails).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(prepareRemoteImage).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("forwards any caller-selected model after trimming whitespace", async () => {
    const runWithDetails = vi.fn<NonNullable<CodexRunner["runWithDetails"]>>(async () => ({ stdout: "Hello", stderr: "" }));
    const app = createServer({ config: config(), runner: { run: async () => "Hello", runWithDetails } });
    try {
      const response = await app.inject({ method: "POST", url, payload: { ...payload, model: " \tnew-client-model\n " } });
      expect(response.statusCode).toBe(200);
      expect(response.json().model).toBe("new-client-model");
      expect(runWithDetails.mock.calls[0]?.[1]).toMatchObject({ model: "new-client-model" });
    } finally { await app.close(); }
  });

  it("validates the required model before other request fields", async () => {
    const run = vi.fn(async () => "Hello");
    const app = createServer({ config: config(), runner: { run } });
    try {
      const response = await app.inject({ method: "POST", url, payload: { input: "Hello", messages: null, text: { format: { type: "unsupported" } } } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { param: "model", code: "invalid_model" } });
      expect(run).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each([
    ["fatal JSONL event", JSON.stringify({ type: "error", message: UNSUPPORTED }), ""],
    ["failed turn", JSON.stringify({ type: "turn.failed", error: { message: UNSUPPORTED } }), ""],
    ["stringified error envelope in a fatal event", JSON.stringify({ type: "error", message: JSON.stringify(UNSUPPORTED_ENVELOPE) }), ""],
    ["stringified error envelope in a failed turn", JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify(UNSUPPORTED_ENVELOPE) } }), ""],
    ["HTTP 400 failure detail", JSON.stringify({ type: "error", message: `unexpected status 400 Bad Request: ${JSON.stringify({ detail: UNSUPPORTED })}, url: https://private.example.test/, request id: secret` }), ""],
    ["stderr error detail", "", `ERROR: ${JSON.stringify({ detail: UNSUPPORTED })}`],
    ["stderr error message", "", `ERROR: ${UNSUPPORTED}`],
    ["HTTP 404 model availability", JSON.stringify({ type: "turn.failed", error: { message: `unexpected status 404 Not Found: ${UNAVAILABLE}, url: https://private.example.test/, cf-ray: secret` } }), ""],
    ["stderr HTTP 404 diagnostic", "", `ERROR: unexpected status 404 Not Found: ${UNAVAILABLE}, url: https://private.example.test/`],
  ])("maps verified %s to a sanitized invalid_model error", async (_name, stdout, stderr) => {
    const app = createServer({ config: config(), runner: {
      run: async () => { throw new CodexRunnerError({ message: "private auth details", code: "NON_ZERO_EXIT", exitCode: 1, stdout, stderr }); },
    } });
    try {
      const response = await app.inject({ method: "POST", url, payload: { ...payload, model: MODEL } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: {
        message: "The requested model is unavailable or unsupported by the configured Codex account. Select a model supported by that account.",
        type: "invalid_request_error", param: "model", code: "invalid_model",
      } });
    } finally { await app.close(); }
  });

  it.each([
    ["Code Mode warning", JSON.stringify({ type: "item.completed", item: { id: "warning", type: "error", message: CODE_MODE_WARNING } }), "", "NON_ZERO_EXIT"],
    ["agent output", JSON.stringify({ type: "item.completed", item: { id: "output", type: "agent_message", text: UNSUPPORTED } }), "", "NON_ZERO_EXIT"],
    ["plain stdout", UNSUPPORTED, "", "NON_ZERO_EXIT"],
    ["different model", JSON.stringify({ type: "error", message: UNSUPPORTED.replace(MODEL, "another-model") }), "", "NON_ZERO_EXIT"],
    ["different unavailable model", JSON.stringify({ type: "error", message: `unexpected status 404 Not Found: ${UNAVAILABLE.replace(MODEL, "another-model")}` }), "", "NON_ZERO_EXIT"],
    ["envelope for a different model", JSON.stringify({ type: "error", message: JSON.stringify({ ...UNSUPPORTED_ENVELOPE, error: { ...UNSUPPORTED_ENVELOPE.error, message: UNSUPPORTED.replace(MODEL, "another-model") } }) }), "", "NON_ZERO_EXIT"],
    ["authentication status envelope", JSON.stringify({ type: "error", message: JSON.stringify({ ...UNSUPPORTED_ENVELOPE, status: 401 }) }), "", "NON_ZERO_EXIT"],
    ["rate limit status envelope", JSON.stringify({ type: "error", message: JSON.stringify({ ...UNSUPPORTED_ENVELOPE, status: 429 }) }), "", "NON_ZERO_EXIT"],
    ["unverified status envelope", JSON.stringify({ type: "error", message: JSON.stringify({ ...UNSUPPORTED_ENVELOPE, status: 404 }) }), "", "NON_ZERO_EXIT"],
    ["string status envelope", JSON.stringify({ type: "error", message: JSON.stringify({ ...UNSUPPORTED_ENVELOPE, status: "400" }) }), "", "NON_ZERO_EXIT"],
    ["wrong outer envelope type", JSON.stringify({ type: "error", message: JSON.stringify({ ...UNSUPPORTED_ENVELOPE, type: "warning" }) }), "", "NON_ZERO_EXIT"],
    ["authentication error type envelope", JSON.stringify({ type: "error", message: JSON.stringify({ ...UNSUPPORTED_ENVELOPE, error: { ...UNSUPPORTED_ENVELOPE.error, type: "authentication_error" } }) }), "", "NON_ZERO_EXIT"],
    ["nonfatal item envelope", JSON.stringify({ type: "item.completed", item: { id: "warning", type: "error", message: JSON.stringify(UNSUPPORTED_ENVELOPE) } }), "", "NON_ZERO_EXIT"],
    ["agent output envelope", JSON.stringify({ type: "item.completed", item: { id: "output", type: "agent_message", text: JSON.stringify(UNSUPPORTED_ENVELOPE) } }), "", "NON_ZERO_EXIT"],
    ["near miss", JSON.stringify({ type: "error", message: `Example: ${UNSUPPORTED}` }), "", "NON_ZERO_EXIT"],
    ["auth failure", JSON.stringify({ type: "error", message: `unexpected status 401 Unauthorized: ${JSON.stringify({ detail: UNSUPPORTED })}` }), "", "NON_ZERO_EXIT"],
    ["rate limit", JSON.stringify({ type: "error", message: "Rate limit reached for model caller-selected-model." }), "", "NON_ZERO_EXIT"],
    ["malformed output", `{"type":"error","message":${JSON.stringify(UNSUPPORTED)}`, "", "NON_ZERO_EXIT"],
    ["quoted stderr", "", `Example: ${UNSUPPORTED}`, "NON_ZERO_EXIT"],
    ["spawn failure", JSON.stringify({ type: "error", message: UNSUPPORTED }), "C:/private/auth.json token=secret", "SPAWN_ERROR"],
    ["invalid output", JSON.stringify({ type: "error", message: UNSUPPORTED }), "C:/private/auth.json token=secret", "INVALID_OUTPUT"],
  ] as const)("keeps %s as a sanitized generic CLI error", async (_name, stdout, stderr, code: CodexRunnerErrorCode) => {
    const app = createServer({ config: config(), runner: {
      run: async () => { throw new CodexRunnerError({ message: "C:/private/auth.json token=secret", code, exitCode: 1, stdout, stderr }); },
    } });
    try {
      const response = await app.inject({ method: "POST", url, payload: { ...payload, model: MODEL } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { type: "api_error", param: null, code: "codex_cli_error" } });
      for (const sensitive of ["private", "auth.json", "token=secret", MODEL, "Example:", "Rate limit"]) expect(response.body).not.toContain(sensitive);
    } finally { await app.close(); }
  });
});

it("retains an empty OpenAI-style model list without a catalog", async () => {
  const app = createServer({ config: config(), runner: { run: async () => "Hello" } });
  try {
    const response = await app.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ object: "list", data: [] });
  } finally { await app.close(); }
});
