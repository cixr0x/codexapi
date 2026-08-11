import { mkdtemp, readFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexRunnerError, type CodexRunner } from "../src/codexRunner.js";
import {
  SafeImageCleanupError,
  type PreparedRemoteImage,
  type SafeImageReason,
  type SafeRemoteImageDependencies,
} from "../src/safeRemoteImage.js";
import { createServer, isMainModule, startServer } from "../src/server.js";

const BROAD_INPUT_ITEM_COUNT = 130_000;

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    translatedText: { type: "string" },
    alternates: { type: "array", items: { type: "string" } },
  },
  required: ["translatedText", "alternates"],
};

function fakeRunner(output = "Codex output") {
  const run = vi.fn<CodexRunner["run"]>(async () => output);
  return { runner: { run }, run };
}

function fakeDetailedRunner(stdout = "Codex output", stderr = "skill loaded") {
  const run = vi.fn<CodexRunner["run"]>(async () => stdout);
  const runWithDetails = vi.fn<NonNullable<CodexRunner["runWithDetails"]>>(async () => ({
    stdout,
    rawStdout: "raw codex events",
    stderr,
    usage: {
      inputTokens: 21,
      cachedInputTokens: 8,
      outputTokens: 5,
      reasoningOutputTokens: 2,
    },
    command: {
      executable: "codex",
      args: [
        "exec",
        "input: Hello",
        "--skip-git-repo-check",
        "--sandbox",
        "danger-full-access",
        "--dangerously-bypass-approvals-and-sandbox",
        "--profile",
        "plain",
      ],
      cwd: "C:/workspace",
      shell: false as const,
    },
  }));
  return { runner: { run, runWithDetails }, run, runWithDetails };
}

function fakeImagePreparer({
  path,
  reason = null,
}: {
  path: string | null;
  reason?: SafeImageReason | null;
}) {
  const cleanup = vi.fn(async () => undefined);
  const prepared: PreparedRemoteImage = { path, reason, cleanup };
  const prepareRemoteImage = vi.fn(
    async (_url: string, _dependencies?: SafeRemoteImageDependencies) => prepared,
  );
  return { cleanup, prepareRemoteImage };
}

function testConfig() {
  return {
    host: "127.0.0.1",
    port: 3001,
    codexBackend: "exec" as const,
    codexWorkspace: join(tmpdir(), "codexapi-test-missing-workspace"),
    codexHome: join(tmpdir(), "codexapi-test-missing-home"),
    codexTimeoutMs: 120000,
    codexDefaultModel: "gpt-5.4-mini",
    codexAllowedModels: ["gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol"],
    codexReasoningEffort: "medium" as const,
    callLoggingEnabled: false,
    callLogDir: join(tmpdir(), "codexapi-test-missing-call-logs"),
  };
}

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

it("fails closed when direct config bypasses safe workspace loading", () => {
  expect(() => createServer({ config: testConfig() })).toThrow(
    "CODEX_WORKSPACE must exist as an empty directory.",
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codexapi-server-logs-"));
  tempDirs.push(dir);
  return dir;
}

describe("Fastify server", () => {
  it("rejects an unsafe direct startup config before probing or listening", async () => {
    const { runner } = fakeRunner();
    const spawn = vi.fn();
    const listen = vi.fn();

    await expect(startServer({ config: testConfig(), runner, spawn, listen })).rejects.toThrow(
      "CODEX_WORKSPACE must exist as an empty directory.",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it.each([
    ["host", { host: "0.0.0.0" }, "HOST must be exactly 127.0.0.1."],
    ["port", { port: 3000 }, "PORT must be exactly 3001."],
  ])("rejects direct non-fixed %s before probing or listening", async (_name, override, message) => {
    const { runner } = fakeRunner();
    const spawn = vi.fn();
    const listen = vi.fn();
    const config = {
      ...testConfig(),
      codexWorkspace: await tempDir(),
      codexHome: await tempDir(),
      ...override,
    };

    await expect(startServer({ config, runner, spawn, listen })).rejects.toThrow(message);
    expect(spawn).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("attests Codex capabilities before binding the startup listener", async () => {
    const events: string[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const outputs = [
      "codex-cli 0.147.0\n",
      [
        "apply_patch_freeform removed false",
        "shell_tool stable false",
        "apps stable false",
        "plugins stable false",
        "shell_snapshot stable false",
        "browser_use stable false",
        "browser_use_external stable false",
        "browser_use_full_cdp_access stable false",
        "in_app_browser stable false",
        "computer_use stable false",
        "code_mode under development false",
        "image_generation stable false",
        "multi_agent stable false",
        "memories experimental false",
        "hooks stable false",
        "tool_suggest stable false",
        "enable_mcp_apps under development false",
        "skill_mcp_dependency_install stable false",
        "tool_call_mcp_elicitation stable false",
        "code_mode_host stable false",
        "remote_plugin stable false",
        "plugin_sharing stable false",
        "enable_fanout under development false",
        "workspace_dependencies stable false",
        "view_image stable false",
        "auth_elicitation stable false",
        "collaboration_modes removed false",
        "enable_request_compression stable false",
        "fast_mode stable false",
        "goals stable false",
        "guardian_approval stable false",
        "in_app_updates stable false",
        "item_ids removed true",
        "mentions_v2 stable false",
        "personality stable false",
        "remote_compaction_v2 stable false",
        "resize_all_images removed true",
        "secret_auth_storage stable false",
        "skill_search stable false",
        "sqlite removed false",
        "steer removed false",
        "unified_exec stable false",
        "terminal_resize_reflow removed true",
        "tool_search_always_defer_mcp_tools removed true",
        "tui_app_server removed true",
        "use_legacy_landlock deprecated false",
      ].join("\n") + "\n",
      "[]\n",
    ];
    const spawn = vi.fn(() => {
      const output = outputs.shift();
      queueMicrotask(() => {
        child.stdout.emit("data", output);
        child.emit("close", 0, null);
      });
      events.push("probe");
      return child as never;
    });
    const { runner } = fakeRunner();
    const listen = vi.fn(async (app: Awaited<ReturnType<typeof createServer>>) => {
      events.push("listen");
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json()).toMatchObject({
        codexCli: {
          version: "0.147.0",
          shellToolFeature: "stable",
          checked: true,
        },
      });
    });

    const app = await startServer({
      config: {
        ...testConfig(),
        codexWorkspace: await tempDir(),
        codexHome: await tempDir(),
      },
      runner,
      spawn,
      listen,
    });

    expect(events).toEqual(["probe", "probe", "probe", "listen"]);
    expect(listen).toHaveBeenCalledOnce();
    await app.close();
  });

  it("detects the entrypoint from a Windows argv path", () => {
    expect(
      isMainModule(
        "file:///C:/PROJECTS/codexapi/dist/server.js",
        "C:\\PROJECTS\\codexapi\\dist\\server.js",
      ),
    ).toBe(true);
  });

  it("returns health status", async () => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      executionPolicy: {
        backend: "exec",
        sandbox: "read-only",
        approvalPolicy: "never",
        mcpServers: "disabled",
      },
    });
    expect(response.body).not.toContain("C:/workspace");
    expect(response.body).not.toContain("C:/codex-home");
    await app.close();
  });

  it("serves a same-origin web interface for testing Codex API calls", async () => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Codex API Tester");
    expect(response.body).toContain("/v1/responses");
    expect(response.body).toContain("/v1/chat/completions");
    expect(response.body).toContain("json_schema");
    await app.close();
  });

  it("returns 400 when chat completion model is not allowlisted", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Hello from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "local-codex",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(runWithDetails).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message: "Model 'local-codex' is not allowed by this local Codex API.",
        type: "invalid_request_error",
        param: "model",
        code: "invalid_model",
      },
    });
    await app.close();
  });

  it("passes the chat completion request model and default reasoning effort to Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Hello from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("user: Hello\nassistant:", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      webSearch: false,
      imagePaths: [],
    });
    await app.close();
  });

  it("returns an OpenAI-style model list", async () => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({ method: "GET", url: "/v1/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      data: [
        { id: "gpt-5.4-mini", object: "model", owned_by: "local" },
        { id: "gpt-5.5", object: "model", owned_by: "local" },
        { id: "gpt-5.6-sol", object: "model", owned_by: "local" },
      ],
    });
    await app.close();
  });

  it("passes the Responses request model and default reasoning effort to Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.5",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("input: Hello", {
      model: "gpt-5.5",
      reasoningEffort: "medium",
      webSearch: false,
      imagePaths: [],
      signal: expect.any(AbortSignal),
    });
    await app.close();
  });

  it("passes the supported Responses web search capability to Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.5",
        input: "Find the current documentation.",
        tools: [{ type: "web_search" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("input: Find the current documentation.", {
      model: "gpt-5.5",
      reasoningEffort: "medium",
      webSearch: true,
      imagePaths: [],
      signal: expect.any(AbortSignal),
    });
    await app.close();
  });

  it("attaches one safely prepared Responses image and cleans it after success", async () => {
    const imageUrl = "https://images.example.test/store-cover.png";
    const imagePath = "C:\\safe-temp\\codexapi-image-random\\image.png";
    const image = fakeImagePreparer({ path: imagePath });
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex");
    const app = createServer({
      config: testConfig(),
      runner,
      prepareRemoteImage: image.prepareRemoteImage,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.5",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Find this game by name and cover." },
              { type: "input_image", image_url: imageUrl, detail: "high" },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(image.prepareRemoteImage).toHaveBeenCalledWith(
      imageUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runWithDetails).toHaveBeenCalledWith(
      [
        "user: Find this game by name and cover.",
        "[store cover attached when available]",
        `image_url: ${imageUrl}`,
      ].join("\n"),
      {
        model: "gpt-5.5",
        reasoningEffort: "medium",
        webSearch: false,
        imagePaths: [imagePath],
        signal: expect.any(AbortSignal),
      },
    );
    expect(image.cleanup).toHaveBeenCalledOnce();
    await app.close();
  });

  it("continues name-only after a safe image rejection and logs only its bounded reason", async () => {
    const logDir = await tempDir();
    const imageUrl =
      "https://caller:secret@169.254.169.254/private-cover.jpg?credential=do-not-log";
    const image = fakeImagePreparer({ path: null, reason: "credentials" });
    const { runner, runWithDetails } = fakeDetailedRunner("Name-only result");
    const app = createServer({
      config: { ...testConfig(), callLoggingEnabled: true, callLogDir: logDir },
      runner,
      prepareRemoteImage: image.prepareRemoteImage,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.5",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Coffee Rush" },
              { type: "input_image", image_url: imageUrl },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith(expect.stringContaining("Coffee Rush"), {
      model: "gpt-5.5",
      reasoningEffort: "medium",
      webSearch: false,
      imagePaths: [],
      signal: expect.any(AbortSignal),
    });
    expect(image.cleanup).toHaveBeenCalledOnce();

    const logContent = await readFile(join(logDir, "calls.jsonl"), "utf8");
    expect(JSON.parse(logContent)).toMatchObject({ imageDiagnosticCode: "credentials" });
    expect(logContent).not.toContain(imageUrl);
    expect(logContent).not.toContain("caller");
    expect(logContent).not.toContain("secret");
    expect(logContent).not.toContain("169.254.169.254");
    expect(logContent).not.toContain("codexapi-image-");
    expect(logContent).not.toContain("ffd8ff");
    await app.close();
  });

  it("cleans a prepared image when the runner fails", async () => {
    const image = fakeImagePreparer({ path: "C:\\safe-temp\\image.jpg" });
    const runner: CodexRunner = {
      run: vi.fn(async () => {
        throw new Error("runner failed");
      }),
    };
    const app = createServer({
      config: testConfig(),
      runner,
      prepareRemoteImage: image.prepareRemoteImage,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Coffee Rush" },
              { type: "input_image", image_url: "https://images.example.test/cover.jpg" },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(image.cleanup).toHaveBeenCalledOnce();
    await app.close();
  });

  it("retains and retries a prepared image after a signaled cleanup failure", async () => {
    const cleanup = vi
      .fn<PreparedRemoteImage["cleanup"]>()
      .mockRejectedValueOnce(new SafeImageCleanupError())
      .mockResolvedValue(undefined);
    const prepareRemoteImage = vi.fn(async () => ({
      path: "C:\\safe-temp\\image.jpg",
      reason: null,
      cleanup,
    }));
    const { runner } = fakeDetailedRunner("Coffee Rush");
    const app = createServer({
      config: testConfig(),
      runner,
      prepareRemoteImage,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Coffee Rush" },
              { type: "input_image", image_url: "https://images.example.test/cover.jpg" },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(cleanup).toHaveBeenCalledTimes(2);
    });
    await app.close();
  });

  it("logs only a bounded code after deferred image cleanup retries are exhausted", async () => {
    const sensitiveImagePath = "C:\\safe-temp\\private-image.jpg";
    const cleanup = vi.fn<PreparedRemoteImage["cleanup"]>(async () => {
      throw new SafeImageCleanupError();
    });
    const prepareRemoteImage = vi.fn(async () => ({
      path: sensitiveImagePath,
      reason: null,
      cleanup,
    }));
    const { runner } = fakeDetailedRunner("Coffee Rush");
    const app = createServer({
      config: testConfig(),
      runner,
      prepareRemoteImage,
    });
    const logError = vi.spyOn(app.log, "error");

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Coffee Rush" },
              { type: "input_image", image_url: "https://images.example.test/cover.jpg" },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(cleanup).toHaveBeenCalledTimes(4);
      expect(logError).toHaveBeenCalledWith(
        { code: "image_cleanup_failed" },
        "Temporary image cleanup failed after bounded retries.",
      );
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain(sensitiveImagePath);
    await app.close();
  });

  it("cleans a prepared image when structured output validation fails", async () => {
    const image = fakeImagePreparer({ path: "C:\\safe-temp\\image.jpg" });
    const { runner } = fakeDetailedRunner('{"translatedText":"Hola"}');
    const app = createServer({
      config: testConfig(),
      runner,
      prepareRemoteImage: image.prepareRemoteImage,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Translate hello." },
              { type: "input_image", image_url: "https://images.example.test/cover.jpg" },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "translation_result",
            strict: true,
            schema: responseSchema,
          },
        },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_structured_output" },
    });
    expect(image.cleanup).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects malformed Responses image syntax before fetching or invoking Codex", async () => {
    const image = fakeImagePreparer({ path: null });
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({
      config: testConfig(),
      runner,
      prepareRemoteImage: image.prepareRemoteImage,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: { url: "file:///etc/passwd" } }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        param: "input",
        code: "invalid_input_image",
      },
    });
    expect(image.prepareRemoteImage).not.toHaveBeenCalled();
    expect(runWithDetails).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects nested chat image syntax before invoking Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "wrapper",
                content: {
                  type: "input_image",
                  image_url: "file:///etc/passwd",
                },
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        param: "messages",
        code: "unsupported_chat_image",
      },
    });
    expect(runWithDetails).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [
      "a message sibling",
      {
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "https://images.example.test/cover.jpg",
              },
            ],
            additional: {
              type: "input_image",
              image_url: "file:///etc/passwd",
            },
          },
        ],
      },
    ],
    [
      "a nested property inside a valid image",
      {
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "https://images.example.test/cover.jpg",
                additional: {
                  type: "input_image",
                  image_url: "file:///etc/passwd",
                },
              },
            ],
          },
        ],
      },
    ],
    [
      "a top-level property outside input",
      {
        input: "Coffee Rush",
        metadata: {
          type: "input_image",
          image_url: "file:///etc/passwd",
        },
      },
    ],
  ])(
    "rejects Responses image syntax in %s before fetching or invoking Codex",
    async (_name, payload) => {
      const image = fakeImagePreparer({ path: null });
      const { runner, runWithDetails } = fakeDetailedRunner();
      const app = createServer({
        config: testConfig(),
        runner,
        prepareRemoteImage: image.prepareRemoteImage,
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          param: "input",
          code: "invalid_input_image",
        },
      });
      expect(image.prepareRemoteImage).not.toHaveBeenCalled();
      expect(runWithDetails).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("rejects image syntax outside chat messages before invoking Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        messages: [{ role: "user", content: "Coffee Rush" }],
        metadata: {
          type: "input_image",
          image_url: "file:///etc/passwd",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        param: "messages",
        code: "unsupported_chat_image",
      },
    });
    expect(runWithDetails).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns bounded 400 for malformed image syntax in a broad request", async () => {
    const input: unknown[] = Array.from(
      { length: BROAD_INPUT_ITEM_COUNT },
      () => "x",
    );
    input[input.length - 1] = {
      type: "input_image",
      image_url: "file:///etc/passwd",
    };
    const payload = { input };
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(
      1024 * 1024,
    );

    const image = fakeImagePreparer({ path: null });
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({
      config: testConfig(),
      runner,
      prepareRemoteImage: image.prepareRemoteImage,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        param: "input",
        code: "invalid_input_image",
      },
    });
    expect(image.prepareRemoteImage).not.toHaveBeenCalled();
    expect(runWithDetails).not.toHaveBeenCalled();
    await app.close();
  });

  it("cancels Codex and promptly cleans a prepared image after request disconnect", async () => {
    const logDir = await tempDir();
    const imageUrl =
      "https://caller:secret@images.example.test/private-cover.jpg?credential=do-not-log";
    const imagePath = "C:\\safe-temp\\codexapi-image-sensitive\\image.jpg";
    let finishCleanup!: () => void;
    const cleanupFinished = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const cleanup = vi.fn(async () => {
      finishCleanup();
    });
    const prepareRemoteImage = vi.fn(async () => ({
      path: imagePath,
      reason: null,
      cleanup,
    }));
    let notifyRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      notifyRunnerStarted = resolve;
    });
    let runnerSignal: AbortSignal | undefined;
    const runWithDetails = vi.fn<NonNullable<CodexRunner["runWithDetails"]>>(
      async (_prompt, options) => {
        runnerSignal = options?.signal;
        notifyRunnerStarted();
        return await new Promise((_resolve, reject) => {
          const rejectCancelled = () => {
            reject(
              new CodexRunnerError({
                message: "Codex command was cancelled.",
                code: "CANCELLED",
                stdout: imageUrl,
                stderr: imagePath,
                command: {
                  executable: "codex",
                  args: ["--image", imagePath],
                  cwd: "C:/sensitive-workspace",
                  shell: false,
                },
              }),
            );
          };
          if (runnerSignal?.aborted) {
            rejectCancelled();
          } else {
            runnerSignal?.addEventListener("abort", rejectCancelled, { once: true });
          }
        });
      },
    );
    const runner: CodexRunner = {
      run: vi.fn(async () => "unused"),
      runWithDetails,
    };
    const requestController = new AbortController();
    const app = createServer({
      config: { ...testConfig(), callLoggingEnabled: true, callLogDir: logDir },
      runner,
      prepareRemoteImage,
      requestSignal: () => requestController.signal,
    });

    const responsePromise = app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Coffee Rush" },
              { type: "input_image", image_url: imageUrl },
            ],
          },
        ],
      },
    });

    await runnerStarted;
    requestController.abort();
    const response = await responsePromise;
    await cleanupFinished;
    expect(response.statusCode).toBe(499);
    expect(response.json()).toMatchObject({
      error: { code: "request_cancelled", message: "Request was cancelled." },
    });
    expect(runnerSignal).toBeInstanceOf(AbortSignal);
    expect(runnerSignal?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    const logContent = await readFile(join(logDir, "calls.jsonl"), "utf8");
    expect(JSON.parse(logContent)).toMatchObject({
      imageDiagnosticCode: "none",
      statusCode: 499,
      error: { code: "request_cancelled" },
    });
    for (const sensitiveValue of [imageUrl, "caller", "secret", imagePath, "--image"]) {
      expect(logContent).not.toContain(sensitiveValue);
    }
    await app.close();
  });

  it("cancels an in-flight image fetch before starting a disconnected Codex run", async () => {
    const requestController = new AbortController();
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const cleanup = vi.fn(async () => undefined);
    const prepareRemoteImage = vi.fn(
      async (_url: string, dependencies?: SafeRemoteImageDependencies) => {
        notifyFetchStarted();
        await new Promise<void>((resolve) => {
          if (dependencies?.signal?.aborted) {
            resolve();
          } else {
            dependencies?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          }
        });
        return {
          path: null,
          reason: "fetch_failed" as const,
          cleanup,
        };
      },
    );
    const runWithDetails = vi.fn<NonNullable<CodexRunner["runWithDetails"]>>(
      async (_prompt, options) => {
        expect(options?.signal?.aborted).toBe(true);
        throw new CodexRunnerError({
          message: "Codex command was cancelled.",
          code: "CANCELLED",
        });
      },
    );
    const app = createServer({
      config: testConfig(),
      runner: { run: vi.fn(async () => "unused"), runWithDetails },
      prepareRemoteImage,
      requestSignal: () => requestController.signal,
    });

    const responsePromise = app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Coffee Rush" },
              {
                type: "input_image",
                image_url: "https://images.example.test/cover.jpg",
              },
            ],
          },
        ],
      },
    });

    await fetchStarted;
    requestController.abort();
    const response = await responsePromise;

    expect(response.statusCode).toBe(499);
    expect(response.json()).toMatchObject({ error: { code: "request_cancelled" } });
    expect(runWithDetails).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    await app.close();
  });

  it("retains a prepared image until late close after a bounded fatal error", async () => {
    const logDir = await tempDir();
    const imageUrl = "https://images.example.test/private-cover.jpg";
    const imagePath = "C:\\safe-temp\\codexapi-image-live\\image.jpg";
    const image = fakeImagePreparer({ path: imagePath });
    let releaseCleanup!: () => void;
    const cleanupWhenSafe = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const fatalError = new CodexRunnerError({
      message: "Codex process could not be terminated.",
      code: "TERMINATION_FAILED",
      stderr: imagePath,
      childMayBeRunning: true,
      cleanupWhenSafe,
    });
    const runner: CodexRunner = {
      run: vi.fn(async () => "unused"),
      runWithDetails: vi.fn(async () => {
        throw fatalError;
      }),
    };
    const app = createServer({
      config: { ...testConfig(), callLoggingEnabled: true, callLogDir: logDir },
      runner,
      prepareRemoteImage: image.prepareRemoteImage,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Coffee Rush" },
              { type: "input_image", image_url: imageUrl },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        message: "Codex process could not be terminated.",
        code: "codex_termination_failed",
      },
    });
    expect(image.cleanup).not.toHaveBeenCalled();
    const logContent = await readFile(join(logDir, "calls.jsonl"), "utf8");
    expect(JSON.parse(logContent)).toMatchObject({
      statusCode: 500,
      error: { code: "codex_termination_failed" },
    });
    expect(logContent).not.toContain(imageUrl);
    expect(logContent).not.toContain(imagePath);
    releaseCleanup();
    await vi.waitFor(() => {
      expect(image.cleanup).toHaveBeenCalledTimes(1);
    });
    await app.close();
  });

  it.each([
    [
      "unsupported Responses tools",
      "/v1/responses",
      { input: "Hello", tools: [{ type: "function", name: "lookup" }] },
      "tools",
    ],
    [
      "unsupported Responses tool choice",
      "/v1/responses",
      { input: "Hello", tools: [{ type: "web_search" }], tool_choice: "required" },
      "tool_choice",
    ],
    [
      "Responses tool choice without tools",
      "/v1/responses",
      { input: "Hello", tool_choice: "required" },
      "tool_choice",
    ],
    [
      "Responses tool choice with empty tools",
      "/v1/responses",
      { input: "Hello", tools: [], tool_choice: "required" },
      "tool_choice",
    ],
    [
      "chat tools",
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "Hello" }], tools: [{ type: "web_search" }] },
      "tools",
    ],
    [
      "chat tool choice",
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "Hello" }], tool_choice: "auto" },
      "tool_choice",
    ],
  ])("returns 400 before invoking Codex for %s", async (_name, url, payload, param) => {
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url,
      payload: { model: "gpt-5.4-mini", ...payload },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { type: "invalid_request_error", param } });
    expect(runWithDetails).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [
      "chat",
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "Hello" }] },
      "https://user:secret@example.test/x",
    ],
    [
      "Responses",
      "/v1/responses",
      { input: "Hello" },
      "C:\\temp\\unvalidated-model.json",
    ],
  ])("does not log an unvalidated model identifier after %s validation fails", async (
    _name,
    url,
    payload,
    unvalidatedModel,
  ) => {
    const logDir = await tempDir();
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({
      config: { ...testConfig(), callLoggingEnabled: true, callLogDir: logDir },
      runner,
    });

    const response = await app.inject({
      method: "POST",
      url,
      payload: { ...payload, model: unvalidatedModel },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { type: "invalid_request_error", param: "model" },
    });
    expect(runWithDetails).not.toHaveBeenCalled();

    const logContent = await readFile(join(logDir, "calls.jsonl"), "utf8");
    expect(JSON.parse(logContent)).not.toHaveProperty("model");
    expect(logContent).not.toContain(unvalidatedModel);
    await app.close();
  });

  it("honors request-level reasoning effort for both compatibility endpoints", async () => {
    const chat = fakeDetailedRunner("Chat response");
    const chatApp = createServer({ config: testConfig(), runner: chat.runner });
    const chatResponse = await chatApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(chatResponse.statusCode).toBe(200);
    expect(chat.runWithDetails).toHaveBeenCalledWith("user: Hello\nassistant:", {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      webSearch: false,
      imagePaths: [],
    });
    await chatApp.close();

    const responses = fakeDetailedRunner("Response");
    const responsesApp = createServer({
      config: testConfig(),
      runner: responses.runner,
    });
    const responsesResponse = await responsesApp.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.6-sol",
        reasoning: { effort: "max" },
        input: "Hello",
      },
    });

    expect(responsesResponse.statusCode).toBe(200);
    expect(responses.runWithDetails).toHaveBeenCalledWith("input: Hello", {
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      webSearch: false,
      imagePaths: [],
      signal: expect.any(AbortSignal),
    });
    expect(responsesResponse.json()).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "max", summary: null },
    });
    await responsesApp.close();
  });

  it("rejects unsupported request reasoning effort before invoking Codex", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.6-sol",
        reasoning: { effort: "maximum" },
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(runWithDetails).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message:
          "reasoning.effort must be one of: low, medium, high, xhigh, max, ultra.",
        type: "invalid_request_error",
        param: "reasoning.effort",
        code: "invalid_reasoning_effort",
      },
    });
    await app.close();
  });

  it("returns 400 when Responses model is not allowlisted", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "local-codex",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(runWithDetails).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message: "Model 'local-codex' is not allowed by this local Codex API.",
        type: "invalid_request_error",
        param: "model",
        code: "invalid_model",
      },
    });
    await app.close();
  });

  it("falls back to the default Codex model when Responses model is absent", async () => {
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("input: Hello", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      webSearch: false,
      imagePaths: [],
      signal: expect.any(AbortSignal),
    });
    await app.close();
  });

  it("maps chat completions to a codex prompt and returns chat completion JSON", async () => {
    const { runner, run } = fakeRunner("Hello from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith("user: Hello\nassistant:");
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "gpt-5.4-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello from Codex" },
          finish_reason: "stop",
        },
      ],
    });
    await app.close();
  });

  it("maps responses input to a codex prompt and returns response JSON", async () => {
    const { runner, run } = fakeRunner("Response from Codex");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        instructions: "Be concise.",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith("instructions: Be concise.\ninput: Hello");
    expect(response.json()).toMatchObject({
      object: "response",
      model: "gpt-5.4-mini",
      status: "completed",
      output_text: "Response from Codex",
    });
    await app.close();
  });

  it("logs response calls when API-level logging is enabled", async () => {
    const logDir = await tempDir();
    const { runner, runWithDetails } = fakeDetailedRunner("Response from Codex", "skill log");
    const app = createServer({
      config: {
        ...testConfig(),
        callLoggingEnabled: true,
        callLogDir: logDir,
      },
      runner,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runWithDetails).toHaveBeenCalledWith("input: Hello", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      webSearch: false,
      imagePaths: [],
      signal: expect.any(AbortSignal),
    });

    const logContent = await readFile(join(logDir, "calls.jsonl"), "utf8");
    const entry = JSON.parse(logContent);
    expect(entry).toEqual({
      id: expect.stringMatching(/^call_/),
      timestamp: expect.any(String),
      endpoint: "/v1/responses",
      method: "POST",
      model: "gpt-5.4-mini",
      webSearchEnabled: false,
      imageDiagnosticCode: "none",
      durationMs: expect.any(Number),
      statusCode: 200,
    });
    expect(logContent).not.toContain("raw codex events");
    expect(logContent).not.toContain("C:/workspace");
    await app.close();
  });

  it("normalizes json_schema Responses output before returning it", async () => {
    const { runner, run } = fakeRunner(
      "Sure:\n{\"translatedText\":\"Hola\",\"alternates\":[\"Buenas\"]}",
    );
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        input: "Translate hello.",
        text: {
          format: {
            type: "json_schema",
            name: "translation_result",
            strict: true,
            schema: responseSchema,
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(run.mock.calls[0]?.[0]).toContain("Return only valid JSON");
    expect(response.json()).toMatchObject({
      object: "response",
      output_text: "{\"translatedText\":\"Hola\",\"alternates\":[\"Buenas\"]}",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: "{\"translatedText\":\"Hola\",\"alternates\":[\"Buenas\"]}",
            },
          ],
        },
      ],
    });
    await app.close();
  });

  it("returns an OpenAI-style error for invalid structured output", async () => {
    const { runner } = fakeRunner("{\"translatedText\":\"Hola\"}");
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        input: "Translate hello.",
        text: {
          format: {
            type: "json_schema",
            name: "translation_result",
            strict: true,
            schema: responseSchema,
          },
        },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        message: "$.alternates is required.",
        type: "api_error",
        param: null,
        code: "invalid_structured_output",
      },
    });
    await app.close();
  });

  it("returns 400 for unsupported Responses text formats", async () => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gpt-5.4-mini",
        input: "Hello",
        text: { format: { type: "grammar" } },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "Unsupported response text format: grammar.",
        type: "invalid_request_error",
        param: "text.format.type",
        code: "unsupported_response_format",
      },
    });
    await app.close();
  });

  it.each([
    ["chat completions", "/v1/chat/completions", { messages: [{ role: "user", content: "Hi" }] }],
    ["responses", "/v1/responses", { input: "Hi" }],
  ])("rejects stream=true for %s", async (_name, url, payload) => {
    const { runner } = fakeRunner();
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url,
      payload: {
        model: "gpt-5.4-mini",
        stream: true,
        ...payload,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "Streaming is not supported by this local Codex API.",
        type: "invalid_request_error",
        param: "stream",
        code: "unsupported_streaming",
      },
    });
    await app.close();
  });

  it("returns OpenAI-style errors when the runner fails", async () => {
    const runner: CodexRunner = {
      run: vi.fn(async () => {
        throw new CodexRunnerError({
          message: "Codex command exited with code 2.",
          code: "NON_ZERO_EXIT",
          exitCode: 2,
          stderr: "Bad prompt",
        });
      }),
    };
    const app = createServer({ config: testConfig(), runner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        message: "Codex command exited with code 2. Bad prompt",
        type: "api_error",
        param: null,
        code: "codex_cli_error",
      },
    });
    await app.close();
  });
});
