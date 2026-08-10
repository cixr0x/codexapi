import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { type CodexCommandDetails } from "./codexRunner.js";
import type { SafeImageReason } from "./safeRemoteImage.js";

export interface CallLogEntry {
  id: string;
  timestamp: string;
  endpoint: string;
  method: string;
  model?: string;
  requestBody?: unknown;
  prompt?: string;
  codexCommand?: CodexCommandDetails;
  rawStdout?: string;
  rawStderr?: string;
  outputText?: string;
  webSearchEnabled: boolean;
  imageDiagnosticCode: "none" | SafeImageReason;
  durationMs: number;
  statusCode: number;
  error?: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export interface CallLogger {
  log(entry: CallLogEntry): Promise<void>;
}

export function createCallLogger({
  enabled,
  logDir,
}: {
  enabled: boolean;
  logDir: string;
}): CallLogger {
  return {
    async log(entry: CallLogEntry): Promise<void> {
      if (!enabled) {
        return;
      }

      await mkdir(logDir, { recursive: true });
      await appendFile(
        join(logDir, "calls.jsonl"),
        `${JSON.stringify(toBoundedLogEntry(entry))}\n`,
        "utf8",
      );
    },
  };
}

function toBoundedLogEntry(entry: CallLogEntry) {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    endpoint: entry.endpoint,
    method: entry.method,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    webSearchEnabled: entry.webSearchEnabled,
    imageDiagnosticCode: entry.imageDiagnosticCode,
    durationMs: entry.durationMs,
    statusCode: entry.statusCode,
    ...(entry.error === undefined
      ? {}
      : {
          error: {
            type: entry.error.type,
            param: entry.error.param,
            code: entry.error.code,
          },
        }),
  };
}
