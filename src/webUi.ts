export const webUiHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>Codex API Tester</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #647084;
      --border: #d8dee8;
      --accent: #166534;
      --accent-hover: #14532d;
      --error: #b42318;
      --code: #0f172a;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family:
        Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }

    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 24px auto;
    }

    header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }

    h1 {
      margin: 0;
      font-size: 26px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .status {
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(320px, 460px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }

    section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }

    h2 {
      margin: 0 0 12px;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0;
    }

    label {
      display: grid;
      gap: 6px;
      margin-bottom: 12px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }

    input,
    select,
    textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text);
      background: #fff;
      font: inherit;
      font-size: 14px;
      padding: 10px 11px;
    }

    textarea {
      min-height: 120px;
      resize: vertical;
    }

    .schema {
      min-height: 220px;
      font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 14px;
    }

    button {
      border: 0;
      border-radius: 7px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      padding: 10px 14px;
    }

    button:hover {
      background: var(--accent-hover);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.58;
    }

    .secondary {
      border: 1px solid var(--border);
      background: #fff;
      color: var(--text);
    }

    .secondary:hover {
      background: #f3f5f8;
    }

    .output-grid {
      display: grid;
      gap: 16px;
    }

    pre {
      min-height: 180px;
      max-height: 420px;
      overflow: auto;
      margin: 0;
      border-radius: 7px;
      background: var(--code);
      color: #e5edf7;
      padding: 14px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
    }

    .message {
      min-height: 20px;
      color: var(--muted);
      font-size: 13px;
    }

    .message.error {
      color: var(--error);
      font-weight: 650;
    }

    .hidden {
      display: none;
    }

    @media (max-width: 820px) {
      main {
        width: min(100vw - 20px, 720px);
        margin: 12px auto;
      }

      header {
        align-items: start;
        flex-direction: column;
      }

      .layout,
      .row {
        grid-template-columns: 1fr;
      }

      .status {
        white-space: normal;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Codex API Tester</h1>
      <div class="status" id="health">Checking health...</div>
    </header>

    <div class="layout">
      <section>
        <h2>Request</h2>
        <form id="request-form">
          <div class="row">
            <label>
              Endpoint
              <select id="endpoint" name="endpoint">
                <option value="/v1/responses">/v1/responses</option>
                <option value="/v1/chat/completions">/v1/chat/completions</option>
              </select>
            </label>
            <label>
              Model
              <select id="model" name="model">
                <option value="gpt-5.4-mini">gpt-5.4-mini</option>
              </select>
            </label>
          </div>

          <label id="instructions-label">
            Instructions
            <textarea id="instructions" name="instructions" rows="3">Be concise.</textarea>
          </label>

          <label>
            Prompt
            <textarea id="prompt" name="prompt" required>Hello from the local Codex API. Reply with one short sentence.</textarea>
          </label>

          <div class="row">
            <label>
              Reasoning effort
              <select id="reasoning" name="reasoning">
                <option value="">API default</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
                <option value="max">max</option>
                <option value="ultra">ultra</option>
              </select>
            </label>
            <label>
              Response format
              <select id="format" name="format">
                <option value="text">text</option>
                <option value="json_object">json_object</option>
                <option value="json_schema">json_schema</option>
              </select>
            </label>
          </div>

          <label>
            Timeout seconds
            <input id="timeout" name="timeout" type="number" min="5" max="240" value="130" />
          </label>

          <label id="schema-label" class="hidden">
            JSON schema
            <textarea id="schema" class="schema" name="schema">{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "answer": { "type": "string" }
  },
  "required": ["answer"]
}</textarea>
          </label>

          <div class="actions">
            <button id="send" type="submit">Send</button>
            <button id="reset" class="secondary" type="button">Reset</button>
          </div>
          <div class="message" id="message"></div>
        </form>
      </section>

      <div class="output-grid">
        <section>
          <h2>Output</h2>
          <pre id="output"></pre>
        </section>
        <section>
          <h2>Request body</h2>
          <pre id="request-preview"></pre>
        </section>
        <section>
          <h2>Raw response</h2>
          <pre id="raw-response"></pre>
        </section>
      </div>
    </div>
  </main>

  <script>
    const form = document.querySelector("#request-form");
    const endpoint = document.querySelector("#endpoint");
    const model = document.querySelector("#model");
    const instructions = document.querySelector("#instructions");
    const instructionsLabel = document.querySelector("#instructions-label");
    const promptInput = document.querySelector("#prompt");
    const reasoning = document.querySelector("#reasoning");
    const format = document.querySelector("#format");
    const timeout = document.querySelector("#timeout");
    const schema = document.querySelector("#schema");
    const schemaLabel = document.querySelector("#schema-label");
    const sendButton = document.querySelector("#send");
    const resetButton = document.querySelector("#reset");
    const message = document.querySelector("#message");
    const output = document.querySelector("#output");
    const requestPreview = document.querySelector("#request-preview");
    const rawResponse = document.querySelector("#raw-response");
    const health = document.querySelector("#health");

    const defaults = {
      endpoint: "/v1/responses",
      model: "gpt-5.4-mini",
      instructions: "Be concise.",
      prompt: "Hello from the local Codex API. Reply with one short sentence.",
      reasoning: "",
      format: "text",
      timeout: "130",
      schema: schema.value
    };

    endpoint.addEventListener("change", refresh);
    format.addEventListener("change", refresh);
    model.addEventListener("change", refresh);
    reasoning.addEventListener("change", refresh);
    instructions.addEventListener("input", refresh);
    promptInput.addEventListener("input", refresh);
    schema.addEventListener("input", refresh);
    timeout.addEventListener("input", refresh);

    resetButton.addEventListener("click", () => {
      endpoint.value = defaults.endpoint;
      model.value = defaults.model;
      instructions.value = defaults.instructions;
      promptInput.value = defaults.prompt;
      reasoning.value = defaults.reasoning;
      format.value = defaults.format;
      timeout.value = defaults.timeout;
      schema.value = defaults.schema;
      output.textContent = "";
      rawResponse.textContent = "";
      setMessage("");
      refresh();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage("Sending...");
      sendButton.disabled = true;
      output.textContent = "";
      rawResponse.textContent = "";

      let body;
      try {
        body = buildBody();
      } catch (error) {
        setMessage(error.message, true);
        sendButton.disabled = false;
        return;
      }

      const controller = new AbortController();
      const timeoutMs = Math.max(5, Number(timeout.value) || 130) * 1000;
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(endpoint.value, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        const text = await response.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
          rawResponse.textContent = JSON.stringify(parsed, null, 2);
        } catch {
          rawResponse.textContent = text;
        }

        if (!response.ok) {
          const errorMessage = parsed?.error?.message || response.statusText || "Request failed.";
          setMessage(errorMessage, true);
          return;
        }

        output.textContent = extractOutput(parsed);
        setMessage("Completed.");
      } catch (error) {
        setMessage(error.name === "AbortError" ? "Request timed out." : error.message, true);
      } finally {
        window.clearTimeout(timer);
        sendButton.disabled = false;
      }
    });

    async function refreshHealth() {
      try {
        const response = await fetch("/health");
        const body = await response.json();
        health.textContent = body.status === "ok" ? "API health: ok" : "API health: unknown";
      } catch {
        health.textContent = "API health: unavailable";
      }
    }

    async function refreshModels() {
      try {
        const response = await fetch("/v1/models");
        const body = await response.json();
        const models = Array.isArray(body.data) ? body.data : [];
        const ids = models.map((entry) => entry?.id).filter((id) => typeof id === "string");
        if (!ids.length) return;

        model.replaceChildren(
          ...ids.map((id) => {
            const option = document.createElement("option");
            option.value = id;
            option.textContent = id;
            return option;
          })
        );
        model.value = ids.includes(defaults.model) ? defaults.model : ids[0];
        refresh();
      } catch {
        // Keep the built-in fallback option when discovery is unavailable.
      }
    }

    function buildBody() {
      const selectedEndpoint = endpoint.value;
      const selectedFormat = format.value;
      const requestModel = model.value.trim();
      const requestReasoning = reasoning.value;
      const prompt = promptInput.value;

      if (selectedEndpoint === "/v1/chat/completions") {
        return {
          ...(requestModel ? { model: requestModel } : {}),
          ...(requestReasoning ? { reasoning_effort: requestReasoning } : {}),
          messages: [
            ...(instructions.value.trim()
              ? [{ role: "system", content: instructions.value.trim() }]
              : []),
            { role: "user", content: prompt }
          ]
        };
      }

      const body = {
        ...(requestModel ? { model: requestModel } : {}),
        ...(requestReasoning ? { reasoning: { effort: requestReasoning } } : {}),
        instructions: instructions.value.trim(),
        input: prompt
      };

      if (selectedFormat === "json_object") {
        body.text = { format: { type: "json_object" } };
      }

      if (selectedFormat === "json_schema") {
        body.text = {
          format: {
            type: "json_schema",
            name: "tester_result",
            strict: true,
            schema: JSON.parse(schema.value)
          }
        };
      }

      return body;
    }

    function extractOutput(body) {
      if (!body) return "";
      if (typeof body.output_text === "string") return body.output_text;
      const message = body.choices?.[0]?.message?.content;
      if (typeof message === "string") return message;
      return JSON.stringify(body, null, 2);
    }

    function setMessage(text, isError = false) {
      message.textContent = text;
      message.classList.toggle("error", isError);
    }

    function refresh() {
      const isResponses = endpoint.value === "/v1/responses";
      instructionsLabel.classList.toggle("hidden", false);
      schemaLabel.classList.toggle("hidden", !isResponses || format.value !== "json_schema");
      format.disabled = !isResponses;
      requestPreview.textContent = safeRequestPreview();
    }

    function safeRequestPreview() {
      try {
        return JSON.stringify(buildBody(), null, 2);
      } catch (error) {
        return error.message;
      }
    }

    refresh();
    refreshModels();
    refreshHealth();
  </script>
</body>
</html>`;
