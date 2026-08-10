# codexapi

`codexapi` is a loopback-only, non-streaming OpenAI-compatible wrapper for one-shot Codex requests. It binds only to `http://127.0.0.1:3001`; do not publish this port through nginx, a firewall rule, or another proxy.

## Constrained runtime

The service runs the package-local platform-native executable from the exact security pin `@openai/codex@0.147.0`. It does not use `PATH`, `CODEX_COMMAND`, command prefixes, profiles, app-server mode, or capability environment toggles.

Before it listens, startup runs the same executable with the dedicated workspace, dedicated `CODEX_HOME`, and sanitized child environment used for inference. Startup fails closed unless all of the following hold:

- the CLI reports exactly `codex-cli 0.147.0`;
- every nonblank `features list` row is unique and well formed, every fixed-disabled feature (including `view_image`) is false, and the only true rows are the five exact `removed` no-op rows recorded in `allowedEnabledFeatures`;
- `mcp list --json` returns an empty inventory.

The `/health` response reports the accepted CLI version, capability policy name (`codexapi-constrained-v1`), and the effective application policy. It never returns command, workspace, or home paths.

Every request uses `codex exec` with a read-only sandbox, `approval_policy="never"`, `mcp_servers={}`, strict config, ignored user/project config, and an ephemeral session. Shell execution, apps, plugins, browser/computer control, code mode, local-image viewing, image generation, multi-agent execution, memories, hooks, tool discovery, plugin sharing, workspace dependencies, and the other fixed disabled features are unavailable. `--disable view_image` disables the host-side local-image tool; trusted, prevalidated request attachments remain a separate explicit `--image` input path. Arbitrary prompts therefore cannot invoke host tools or inherited MCP servers. Web search is off unless the single allowed Responses declaration below opts in.

## Requirements and configuration

- Node.js 20 or newer
- `npm install` (installs the pinned native Codex CLI)
- An existing dedicated `CODEX_HOME` with its own Codex authentication
- An existing, empty, non-symlink `CODEX_WORKSPACE` outside this checkout and the current working directory

Copy `.env.example` and set the two dedicated paths. The service accepts only these runtime settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Fixed and enforced loopback bind host |
| `PORT` | `3001` | Fixed and enforced local API port |
| `CODEX_HOME` | required | Dedicated Codex home and authentication boundary |
| `CODEX_WORKSPACE` | required | Empty dedicated inference directory |
| `CODEX_TIMEOUT_MS` | `120000` | Per-request Codex timeout |
| `CODEX_DEFAULT_MODEL` | `gpt-5.4-mini` | Model used when callers omit `model` |
| `CODEX_ALLOWED_MODELS` | bundled allowlist | Accepted request model IDs |
| `CODEX_REASONING_EFFORT` | `medium` | Default reasoning effort |
| `CODEX_CALL_LOGGING` | `false` | Enables local JSONL request logging |
| `CODEX_CALL_LOG_DIR` | `.codexapi/logs` | JSONL log location when enabled |

```powershell
$env:CODEX_HOME = "C:\CodexAPI\home"
$env:CODEX_WORKSPACE = "C:\CodexAPI\inference-workspace"
npm run dev:codex
```

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Streaming is not supported. `stream: true` receives an OpenAI-style `400`.

Models must be in `CODEX_ALLOWED_MODELS`; absent or blank models use `CODEX_DEFAULT_MODEL`. Reasoning effort defaults to `medium` and can be overridden by `reasoning.effort` on Responses or `reasoning_effort` on Chat Completions.

Responses `text.format` supports `{ "type": "text" }`, `{ "type": "json_object" }`, and strict `{ "type": "json_schema", "name": "...", "schema": { ... } }`. Schema output is passed through Codex's native output-schema option, validated again locally, and temporary schema files are removed after the command ends.

## Responses capability and image contract

Responses accepts no tools (web search remains disabled) or exactly this one-item declaration:

```json
{ "tools": [{ "type": "web_search" }] }
```

When `tools` is present, no other tool types, additional fields, duplicates, or non-`"auto"` `tool_choice` values are accepted. Chat Completions does not accept tools or `tool_choice` at all.

Responses accepts at most one optional image part, only inside a message-content array:

```json
{
  "input": [{
    "role": "user",
    "content": [
      { "type": "input_text", "text": "Find the BGG entry for Coffee Rush." },
      { "type": "input_image", "image_url": "https://images.example.test/cover.webp", "detail": "high" }
    ]
  }]
}
```

The image must provide a string `image_url`; `file_id`, a second image, or image-shaped data elsewhere in the request is rejected. The server accepts only public HTTP(S) URLs on ports 80/443, follows at most three redirects, has a 10-second fetch timeout and 8 MiB limit, and requires matching JPEG, PNG, or WebP content type and magic bytes. It passes a verified temporary file to Codex and removes it afterward.

If the image is absent, rejected, unreachable, oversized, or unsupported, the request continues using name/text only. The API records only a bounded diagnostic reason, not image bytes, temporary paths, or URL credentials.

## Examples

Chat Completions:

```bash
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

Responses with explicit web search and an optional store image:

```bash
curl http://127.0.0.1:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "tools": [{ "type": "web_search" }],
    "input": [{
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Find the BGG entry for Coffee Rush." },
        { "type": "input_image", "image_url": "https://images.example.test/cover.webp", "detail": "high" }
      ]
    }]
  }'
```

## Development

```bash
npm test
npm run typecheck
npm run build
```

Call logging can contain prompts and responses. Keep it off unless local diagnosis specifically requires it.
