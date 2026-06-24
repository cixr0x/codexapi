import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createCallLogger, type CallLogger, type CallLogEntry } from "./callLogger.js";
import { type AppConfig, loadConfig } from "./config.js";
import {
  CodexRunnerError,
  createCodexRunner,
  type CodexRunResult,
  type CodexRunner,
} from "./codexRunner.js";
import {
  OpenAIHttpError,
  buildChatPrompt,
  buildResponsesPrompt,
  createChatCompletion,
  createResponse,
  openAiError,
} from "./openaiCompat.js";
import {
  StructuredOutputError,
  getResponseTextFormat,
  normalizeStructuredOutput,
} from "./structuredOutput.js";

export interface CreateServerOptions {
  config?: AppConfig;
  runner?: CodexRunner;
  logger?: boolean;
}

export function createServer(options: CreateServerOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const runner =
    options.runner ??
    createCodexRunner({
      command: config.codexCommand,
      commandArgs: config.codexCommandArgs,
      workspace: config.codexWorkspace,
      profile: config.codexProfile,
      ignoreUserConfig: config.codexIgnoreUserConfig,
      disablePlugins: config.codexDisablePlugins,
      disableShellSnapshot: config.codexDisableShellSnapshot,
      ephemeral: config.codexEphemeral,
      ignoreRules: config.codexIgnoreRules,
      timeoutMs: config.codexTimeoutMs,
    });
  const callLogger = createCallLogger({
    enabled: config.callLoggingEnabled,
    logDir: config.callLogDir,
  });

  const app = Fastify({ logger: options.logger ?? false });

  void app.register(cors, { origin: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OpenAIHttpError) {
      sendOpenAIError(reply, error);
      return;
    }

    const statusCode = hasStatusCode(error) ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Unexpected server error.";

    sendOpenAIError(
      reply,
      openAiError(
        message || "Unexpected server error.",
        statusCode >= 500 ? "server_error" : "invalid_request_error",
        null,
        statusCode >= 500 ? "internal_error" : "bad_request",
        statusCode,
      ),
    );
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/v1/models", async () => ({
    object: "list",
    data: [
      {
        id: config.openAICompatModel,
        object: "model",
        created: 0,
        owned_by: "local",
      },
    ],
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    const startedAt = Date.now();
    const callId = createCallId();
    let prompt: string | undefined;
    let runResult: CodexRunResult | undefined;

    try {
      prompt = buildChatPrompt(request.body);
      runResult = await runPromptWithDetails(runner, prompt);
      const responseBody = createChatCompletion({
        model: config.openAICompatModel,
        content: runResult.stdout,
      });
      await logCall(callLogger, {
        id: callId,
        startedAt,
        endpoint: "/v1/chat/completions",
        method: request.method,
        requestBody: request.body,
        model: config.openAICompatModel,
        prompt,
        codexCommand: runResult.command,
        rawStdout: runResult.stdout,
        rawStderr: runResult.stderr,
        outputText: runResult.stdout,
        statusCode: 200,
      });
      return responseBody;
    } catch (error) {
      const mappedError = mapError(error);
      await logCall(callLogger, {
        id: callId,
        startedAt,
        endpoint: "/v1/chat/completions",
        method: request.method,
        requestBody: request.body,
        model: config.openAICompatModel,
        prompt,
        codexCommand: runResult?.command ?? runnerErrorCommand(error),
        rawStdout: runResult?.stdout,
        rawStderr: runResult?.stderr ?? runnerErrorStderr(error),
        statusCode: mappedError.statusCode,
        error: mappedError.body.error,
      });
      sendOpenAIError(reply, mappedError);
      return undefined;
    }
  });

  app.post("/v1/responses", async (request, reply) => {
    const startedAt = Date.now();
    const callId = createCallId();
    let prompt: string | undefined;
    let runResult: CodexRunResult | undefined;
    let outputText: string | undefined;

    try {
      prompt = buildResponsesPrompt(request.body);
      const format = getResponseTextFormat(request.body);
      runResult = await runPromptWithDetails(runner, prompt);
      outputText = normalizeStructuredOutput(runResult.stdout, format);
      const responseBody = createResponse({
        model: config.openAICompatModel,
        content: outputText,
      });
      await logCall(callLogger, {
        id: callId,
        startedAt,
        endpoint: "/v1/responses",
        method: request.method,
        requestBody: request.body,
        model: config.openAICompatModel,
        prompt,
        codexCommand: runResult.command,
        rawStdout: runResult.stdout,
        rawStderr: runResult.stderr,
        outputText,
        statusCode: 200,
      });
      return responseBody;
    } catch (error) {
      const mappedError = mapError(error);
      await logCall(callLogger, {
        id: callId,
        startedAt,
        endpoint: "/v1/responses",
        method: request.method,
        requestBody: request.body,
        model: config.openAICompatModel,
        prompt,
        codexCommand: runResult?.command ?? runnerErrorCommand(error),
        rawStdout: runResult?.stdout,
        rawStderr: runResult?.stderr ?? runnerErrorStderr(error),
        outputText,
        statusCode: mappedError.statusCode,
        error: mappedError.body.error,
      });
      sendOpenAIError(reply, mappedError);
      return undefined;
    }
  });

  return app;
}

function mapError(error: unknown): OpenAIHttpError {
  if (error instanceof OpenAIHttpError) {
    return error;
  }

  if (error instanceof CodexRunnerError) {
    return openAiError(
      codexErrorMessage(error),
      "api_error",
      null,
      error.code === "TIMEOUT" ? "codex_timeout" : "codex_cli_error",
      error.code === "TIMEOUT" ? 504 : 500,
    );
  }

  if (error instanceof StructuredOutputError) {
    return openAiError(
      error.message,
      error.statusCode >= 500 ? "api_error" : "invalid_request_error",
      error.param,
      error.code,
      error.statusCode,
    );
  }

  if (error instanceof Error) {
    return openAiError(error.message, "server_error", null, "internal_error", 500);
  }

  return openAiError("Unexpected server error.", "server_error", null, "internal_error", 500);
}

function codexErrorMessage(error: CodexRunnerError): string {
  const stderr = error.stderr?.trim();
  if (!stderr) {
    return error.message;
  }

  return `${error.message} ${stderr.slice(0, 1000)}`;
}

function sendOpenAIError(reply: FastifyReply, error: OpenAIHttpError): void {
  reply.status(error.statusCode).send(error.body);
}

async function runPromptWithDetails(
  runner: CodexRunner,
  prompt: string,
): Promise<CodexRunResult> {
  if (runner.runWithDetails) {
    return runner.runWithDetails(prompt);
  }

  return {
    stdout: await runner.run(prompt),
    stderr: "",
  };
}

async function logCall(
  logger: CallLogger,
  {
    startedAt,
    ...entry
  }: Omit<CallLogEntry, "timestamp" | "durationMs"> & { startedAt: number },
): Promise<void> {
  try {
    await logger.log({
      ...entry,
      timestamp: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
    });
  } catch {
    // Call logging must never change API behavior.
  }
}

function runnerErrorStderr(error: unknown): string | undefined {
  return error instanceof CodexRunnerError ? error.stderr : undefined;
}

function runnerErrorCommand(error: unknown): CodexRunResult["command"] {
  return error instanceof CodexRunnerError ? error.command : undefined;
}

function createCallId(): string {
  return `call_${randomUUID().replaceAll("-", "")}`;
}

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createServer({ config, logger: true });
  await app.listen({ host: config.host, port: config.port });
}

export function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  return Boolean(argvPath && importMetaUrl === pathToFileURL(argvPath).href);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
