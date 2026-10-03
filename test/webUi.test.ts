import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { webUiHtml } from "../src/webUi.js";

function uiHarness() {
  const nodes = new Map<string, {
    value: string; textContent: string; disabled: boolean;
    listeners: Record<string, (event: { preventDefault(): void }) => unknown>;
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => unknown): void;
    classList: { toggle: ReturnType<typeof vi.fn> };
  }>();
  function node(selector: string) {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: selector === "#endpoint" ? "/v1/responses" : selector === "#format" ? "text" : "",
      textContent: "", disabled: false, listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      classList: { toggle: vi.fn() },
    });
    return nodes.get(selector)!;
  }
  const fetch = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url === "/health") return { json: async () => ({ status: "ok" }) };
    return { ok: true, json: async () => ({ data: [] }), text: async () => JSON.stringify({ output_text: "Hello" }) };
  });
  const script = webUiHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("UI script missing");
  runInNewContext(script, {
    document: { querySelector: node }, fetch, AbortController,
    window: { setTimeout: () => 1, clearTimeout: () => undefined },
  });
  return { node, fetch, submit: () => node("#request-form").listeners.submit!({ preventDefault: () => undefined }) };
}

describe.each(["/v1/responses", "/v1/chat/completions"])("UI model for %s", (endpoint) => {
  it("requires an explicit nonblank model before sending", async () => {
    const ui = uiHarness();
    ui.node("#endpoint").value = endpoint;
    ui.node("#model").value = "  \t ";
    await ui.submit();
    expect(ui.fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toEqual([]);
    expect(ui.node("#message").textContent).toContain("Model is required");
  });

  it("sends and previews a trimmed editable caller-selected model", async () => {
    const ui = uiHarness();
    ui.node("#endpoint").value = endpoint;
    ui.node("#model").value = "  model-from-client  ";
    ui.node("#model").listeners.input?.({ preventDefault: () => undefined });
    expect(JSON.parse(ui.node("#request-preview").textContent).model).toBe("model-from-client");
    await ui.submit();
    const request = ui.fetch.mock.calls.find(([, options]) => options?.method === "POST");
    expect(request?.[0]).toBe(endpoint);
    expect(JSON.parse(String(request?.[1]?.body)).model).toBe("model-from-client");
  });
});
