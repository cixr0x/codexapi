import type { CodexRunnerErrorCode } from "./codexRunner.js";
import { CodexStartupWarnings } from "./codexWarnings.js";

export interface CodexDiagnostics {
  attemptCount: number;
  elapsedMs: number;
  runnerCode?: CodexRunnerErrorCode;
  originalRunnerCode?: CodexRunnerErrorCode;
  exitCode?: number | null;
  failureCategory: "none" | "recovered" | "upstream_transient" | "unknown_cli_failure" | "invalid_output" | "incomplete_capture" | "cleanup_failed" | "cancelled" | "timeout" | "termination_failed" | "startup_failed";
  upstreamStatus?: 502 | 503 | 504;
  reconnectCount: number;
  captureComplete: boolean;
}

const UPSTREAM_503_DETAIL = "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.";

/** Only the observed pinned-CLI progress grammar; never an arbitrary error. */
export function reconnectProgress(message: unknown): number | undefined {
  if (typeof message !== "string") return undefined;
  const match = /^Reconnecting\.\.\. ([1-5])\/5 \((.*)\)$/.exec(message);
  return match?.[2] === `unexpected status 503 Service Unavailable: ${UPSTREAM_503_DETAIL}`
    ? Number(match[1]) : undefined;
}

export interface TerminalDiagnostic {
  captureComplete: boolean;
  upstreamStatus?: 502 | 503 | 504;
  reconnectCount: number;
}

/** Fail closed on incomplete/mixed captures; generated text cannot supply evidence. */
export function terminalDiagnostic(stdout: string, stderr: string, captureComplete: boolean, model?: string): TerminalDiagnostic {
  let complete = captureComplete;
  let veto = false;
  let terminalStatus: 502 | 503 | 504 | undefined;
  let reconnectCount = 0;
  let lastReconnect = 0;
  let phase: "thread" | "turn" | "active" | "failed" = "thread";
  let diagnosticStarted = false;
  const warnings = new CodexStartupWarnings(model);
  const items = new Map<string, { type: string; completed: boolean }>();
  for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) {
    if (line.length > 16_384) { complete = false; continue; }
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || typeof parsed.type !== "string") { complete = false; continue; }
      event = parsed;
    } catch { complete = false; continue; }
    if (phase === "failed") { veto = true; continue; }
    if (event.type === "thread.started" && phase === "thread" && typeof event.thread_id === "string" && event.thread_id.trim()) { phase = "turn"; continue; }
    if (event.type === "turn.started" && phase === "turn") { phase = "active"; continue; }
    if (phase === "turn" && event.type === "item.completed" && isRecord(event.item) && typeof event.item.id === "string" && event.item.id.trim() && !items.has(event.item.id) && event.item.type === "error" && warnings.accept(event.item.message)) {
      items.set(event.item.id, { type: "error", completed: true });
      continue;
    }
    if (phase !== "active") { veto = true; continue; }
    if (event.type === "error") {
      const progress = reconnectProgress(event.message);
      if (progress !== undefined && !diagnosticStarted) {
        if (progress <= lastReconnect) veto = true;
        lastReconnect = progress;
        reconnectCount++;
        continue;
      }
      diagnosticStarted = true;
      const status = transientStatus(event.message);
      if (status === undefined || (terminalStatus !== undefined && status !== terminalStatus)) veto = true;
      terminalStatus = status;
      continue;
    }
    if (event.type === "turn.failed" && isRecord(event.error)) {
      const status = transientStatus(event.error.message);
      if (status === undefined || (terminalStatus !== undefined && status !== terminalStatus)) veto = true;
      terminalStatus = status;
      phase = "failed";
      continue;
    }
    if (!diagnosticStarted && ["item.started", "item.updated", "item.completed"].includes(String(event.type)) && isRecord(event.item) && typeof event.item.id === "string" && event.item.id.trim() && typeof event.item.type === "string" && event.item.type.trim() && !["command_execution", "error"].includes(event.item.type)) {
      const item = event.item;
      const id = item.id as string;
      const type = item.type as string;
      const existing = items.get(id);
      if ((existing && (existing.type !== type || existing.completed)) || (event.type === "item.started" && existing) || (event.type === "item.updated" && !existing) || (["agent_message", "reasoning"].includes(type) && (existing || event.type !== "item.completed" || typeof item.text !== "string"))) { veto = true; continue; }
      items.set(id, { type, completed: event.type === "item.completed" });
      continue;
    }
    veto = true;
  }
  // No other stderr grammar has been verified for retry. Unknown diagnostics may
  // conceal a permanent failure, so every nonempty line must agree with stdout.
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!line.trim().startsWith("ERROR:")) { veto = true; continue; }
    const status = transientStatus(line.trim().slice(6).trimStart());
    if (status === undefined || status !== terminalStatus) veto = true;
  }
  return { captureComplete: complete, reconnectCount, ...(complete && !veto && terminalStatus !== undefined ? { upstreamStatus: terminalStatus } : {}) };
}

function transientStatus(message: unknown): 502 | 503 | 504 | undefined {
  if (typeof message !== "string" || message.length > 16_384) return undefined;
  const match = /^unexpected status (502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout): [\s\S]+$/.exec(message);
  return match ? Number(match[1].slice(0, 3)) as 502 | 503 | 504 : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
