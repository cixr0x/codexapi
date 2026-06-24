import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { pathToFileURL } from "node:url";

import { type AppConfig, loadConfig } from "./config.js";
import {
  CodexRunnerError,
  createCodexRunner,
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
      workspace: config.codexWorkspace,
      profile: config.codexProfile,
      timeoutMs: config.codexTimeoutMs,
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
    try {
      const prompt = buildChatPrompt(request.body);
      const content = await runner.run(prompt);
      return createChatCompletion({
        model: config.openAICompatModel,
        content,
      });
    } catch (error) {
      sendOpenAIError(reply, mapError(error));
      return undefined;
    }
  });

  app.post("/v1/responses", async (request, reply) => {
    try {
      const prompt = buildResponsesPrompt(request.body);
      const content = await runner.run(prompt);
      return createResponse({
        model: config.openAICompatModel,
        content,
      });
    } catch (error) {
      sendOpenAIError(reply, mapError(error));
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
