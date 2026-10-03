import { CodexRunnerError } from "./codexRunner.js";

const MAX_DIAGNOSTIC_LINE_LENGTH = 16_384;

/** Recognize only verified request-model rejections from a failed CLI process. */
export function isInvalidCodexModel(error: CodexRunnerError, model: string | undefined): boolean {
  if (error.code !== "NON_ZERO_EXIT" || model === undefined) return false;

  for (const line of (error.stdout ?? "").split(/\r?\n/)) {
    const event = parseRecord(line);
    if (!event) continue;
    const failure = event.type === "error" ? event : event.type === "turn.failed" && isRecord(event.error) ? event.error : undefined;
    if (failure && isModelRejection(failure.message, model)) return true;
  }

  for (const line of (error.stderr ?? "").split(/\r?\n/)) {
    const diagnostic = line.trim();
    if (diagnostic.startsWith("ERROR: ") && isModelRejection(diagnostic.slice(7), model)) return true;
  }
  return false;
}

function isModelRejection(message: unknown, model: string): boolean {
  if (typeof message !== "string" || message.length > MAX_DIAGNOSTIC_LINE_LENGTH) return false;
  const unsupported = `The '${model}' model is not supported when using Codex with a ChatGPT account.`;
  const unavailable = `The model \`${model}\` does not exist or you do not have access to it.`;
  if (message === unsupported || message === unavailable) return true;

  // CLI HTTP failures may append URL and trace identifiers. They are never returned.
  const badRequestPrefix = "unexpected status 400 Bad Request: ";
  const notFoundPrefix = "unexpected status 404 Not Found: ";
  if (message.startsWith(notFoundPrefix)) {
    const detail = message.slice(notFoundPrefix.length);
    return detail === unavailable || detail.startsWith(`${unavailable}, url: `);
  }
  const detail = message.startsWith(badRequestPrefix)
    ? message.slice(badRequestPrefix.length).split(", url: ", 1)[0]!
    : message;
  const body = parseRecord(detail);
  return body?.detail === unsupported;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (line.length > MAX_DIAGNOSTIC_LINE_LENGTH) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
