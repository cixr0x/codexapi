import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface CallLogEntry {
  id: string;
  timestamp: string;
  endpoint: string;
  method: string;
  model?: string;
  requestBody?: unknown;
  prompt?: string;
  rawStdout?: string;
  rawStderr?: string;
  outputText?: string;
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
        `${JSON.stringify(entry)}\n`,
        "utf8",
      );
    },
  };
}
