# codexapi

`codexapi` is a loopback-only, non-streaming OpenAI-compatible wrapper for one-shot Codex requests. It binds only to `http://127.0.0.1:3001`; do not publish this port through nginx, a firewall rule, or another proxy.

## Capable isolated runtime

The pinned package-local `@openai/codex@0.147.0` CLI starts only after capability attestation succeeds. Its fixed policy is `codexapi-capable-isolated-v2`: the checked-in `codexapi-runtime` profile enables live public-web research and `view_image`; immutable runner switches separately enable browser use (external and in-app), Code Mode, and the Code Mode host.

Shell tools, shell snapshots, and unified execution are disabled. A command-execution event from Codex fails the request closed. Requests inherit an empty MCP inventory, ignore user and project configuration, and run ephemerally. Codex execution uses a newly created per-request child workspace, removed after it is safe to clean up. `/var/lib/codexapi` is the sole explicit persistent `ReadWritePaths` area for those workspaces; `PrivateTmp` provides API-owned temporary storage for safe generic image downloads.

The production unit runs as the dedicated `codexapi` user and group, binds `HOST=127.0.0.1` and `PORT=3001`, and uses `CODEX_HOME=/var/lib/codexapi/home` plus `CODEX_WORKSPACE=/var/lib/codexapi/workspace`. Before Node starts, it installs the checked-in profile into that dedicated home with mode `0400`. The checkout is read-only; `/var/lib/codexapi` is its sole explicit persistent `ReadWritePaths` area; and the Ludora admin checkout, `/home`, and `/root` are inaccessible to the service.

After building the checked-in revision on the production VM, a root operator can run `sudo npm run verify:isolation`. It calls only `http://127.0.0.1:3001`, creates random disposable markers in fixed protected roots, and prints exactly `{"status":"ok","isolation":"verified"}` when the hostile-access and cancellation-cleanup probes pass.

`GET /health` reports the accepted CLI version, policy name, and the required and prohibited features. It deliberately does not expose paths, command details, or an exhaustive feature table.

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
| `CODEX_WORKSPACE` | required | Empty base directory for isolated request workspaces |
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

Models must be in `CODEX_ALLOWED_MODELS`; absent or blank models use `CODEX_DEFAULT_MODEL`. Reasoning effort defaults to `medium` and can be overridden by `reasoning.effort` on Responses or `reasoning_effort` on Chat Completions. Responses `text.format` supports `{ "type": "text" }`, `{ "type": "json_object" }`, and strict `{ "type": "json_schema", "name": "...", "schema": { ... } }`.

## Responses and images

Responses requests use the fixed live-search policy without a `tools` declaration. The legacy single-item `{ "tools": [{ "type": "web_search" }] }` declaration remains accepted for compatibility but does not change the available capability; other tool declarations are rejected. Chat Completions does not accept tools or `tool_choice`.

Generic Responses `input_image` compatibility remains supported for one validated public HTTP(S) JPEG, PNG, or WebP image. The server follows limited redirects, enforces a timeout and size limit, passes a verified temporary file to Codex, and removes it afterward. Image failures continue as text-only requests with a bounded diagnostic reason.

Ludora BGG matching is separate: it supplies its public `imageUrl` as ordinary prompt text for Codex to open and compare, rather than using `input_image` transport.

## Examples

Responses research with no tools declaration (live search is already enabled):

```bash
curl http://127.0.0.1:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "input": "Find the BoardGameGeek entry for Coffee Rush and cite its official page."
  }'
```

Generic `input_image` compatibility:

```json
{
  "input": [{
    "role": "user",
    "content": [
      { "type": "input_text", "text": "Describe this game cover." },
      { "type": "input_image", "image_url": "https://images.example.test/cover.webp", "detail": "high" }
    ]
  }]
}
```

BGG matching prompt text:

```json
{
  "input": "Match this item to BoardGameGeek. itemName: Coffee Rush; imageUrl: https://images.example.test/cover.webp"
}
```

## Development

```bash
npm test
npm run typecheck
npm run build
```

Call logging can contain prompts and responses. Keep it off unless local diagnosis specifically requires it.
