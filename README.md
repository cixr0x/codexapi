# codexapi

`codexapi` is a loopback-only, non-streaming OpenAI-compatible wrapper for one-shot Codex requests. It binds only to `http://127.0.0.1:3001`; do not publish this port through nginx, a firewall rule, or another proxy.

## Capable isolated runtime

The pinned package-local `@openai/codex@0.160.0` CLI starts only after capability attestation succeeds. Its fixed policy is `codexapi-capable-isolated-v2`: the checked-in `codexapi-runtime` profile enables live public-web research and `view_image`; immutable runner switches separately enable browser use (external and in-app), Code Mode, and the Code Mode host.

CLI 0.160.0 is the current stable release verified for this upgrade. Disabling `unified_exec` requires managed administrator requirements; ordinary disable switches are insufficient. `deploy/codex-managed/requirements.toml` enforces `[features] unified_exec = false`. The production unit binds that directory read-only at `/etc/codex` inside its own mount namespace. Other Codex processes retain their existing system policy. systemd may create an empty host `/etc/codex` mountpoint directory when absent; it installs no host requirements file. Preserve any existing host policy and never copy this service policy into the machine-wide Codex directory. See [the official requirements reference](https://learn.chatgpt.com/docs/config-file/config-reference#requirementstoml).

Shell tools, shell snapshots, and unified execution are disabled. A command-execution event from Codex fails the request closed. Requests inherit an empty MCP inventory, ignore user and project configuration, and run ephemerally. Codex execution uses a newly created per-request child workspace, removed after it is safe to clean up. `/var/lib/codexapi` is the sole explicit persistent `ReadWritePaths` area for those workspaces; `PrivateTmp` provides API-owned temporary storage for safe generic image downloads.

The production unit runs as the dedicated `codexapi` user and group, binds `HOST=127.0.0.1` and `PORT=3001`, and uses `CODEX_HOME=/var/lib/codexapi/home` plus `CODEX_WORKSPACE=/var/lib/codexapi/workspace`. Before Node starts, it installs the checked-in profile into that dedicated home with mode `0400`. The checkout is read-only; `/var/lib/codexapi` is its sole explicit persistent `ReadWritePaths` area; and the Ludora admin checkout, `/home`, and `/root` are inaccessible to the service.

After building the checked-in revision on the production VM, a root operator can run `sudo npm run --silent verify:isolation` (or `sudo node dist/src/verifyIsolation.js`). The verification client selects `gpt-5.6-terra` when `CODEX_ISOLATION_MODEL` is absent and sends an explicit `model` in both probes. This is a verification-client default, not an API/server fallback; every API caller must still provide its own model. To override the client's selection, run `sudo env CODEX_ISOLATION_MODEL='<supported-model-id>' npm run --silent verify:isolation`. An explicitly empty or whitespace-only setting is rejected before any canary resources or probes are created.

The verification client calls only `http://127.0.0.1:3001`, creates a random root-owned `0711` canary directory and a `0400` `codexapi` marker inside each fixed protected root, and prints exactly `{"status":"ok","isolation":"verified"}` when the hostile-access and cancellation-cleanup probes pass. The directory permits traversal but prevents the service from renaming, unlinking, or replacing the marker in place; marker link-count attestation detects hardlink tampering. Cleanup attests both directory and marker identities before removal. Where a protected root's parent is not traversable by the service, the systemd path denial is the acceptance layer and the canary directory remains as permissive as this ownership boundary safely permits.

`GET /health` reports the accepted CLI version, policy name, and the required and prohibited features. It deliberately does not expose paths, command details, or an exhaustive feature table.

## Requirements and configuration

- Node.js 20 or newer
- `npm install` (installs the pinned native Codex CLI)
- An existing dedicated `CODEX_HOME` with its own Codex authentication
- An existing, empty, non-symlink `CODEX_WORKSPACE` outside this checkout and the current working directory
- The checked-in runtime profile and managed requirements supplied through an isolated Linux service namespace

Copy `.env.example` and set the two dedicated paths. The service accepts only these runtime settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Fixed and enforced loopback bind host |
| `PORT` | `3001` | Fixed and enforced local API port |
| `CODEX_HOME` | required | Dedicated Codex home and authentication boundary |
| `CODEX_WORKSPACE` | required | Empty base directory for isolated request workspaces |
| `CODEX_TIMEOUT_MS` | `120000` | Per-request Codex timeout |
| `CODEX_REASONING_EFFORT` | `medium` | Default reasoning effort |
| `CODEX_CALL_LOGGING` | `false` | Enables local JSONL request logging |
| `CODEX_CALL_LOG_DIR` | `.codexapi/logs` | JSONL log location when enabled |

Native Windows development can install the pinned executable and run the test suite, but it cannot start this production policy unchanged. Codex 0.160.0 reads administrator requirements from `%ProgramData%\OpenAI\Codex\requirements.toml`; a requirements file under `CODEX_HOME` does not enforce this setting. This repository does not write that machine-wide policy. Startup fails closed when `unified_exec` remains enabled. The checked-in runtime profile also contains POSIX filesystem paths, so a Windows runtime would require a separately reviewed permission profile and administrator-managed execution boundary. Use Linux for the current service. Do not weaken the policy or reuse another user's credentials to make native Windows startup succeed. For local Linux development, provide the same read-only service namespace and dedicated profile/home/workspace before running the fixed `npm run dev:codex` command.

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Streaming is not supported. `stream: true` receives an OpenAI-style `400`.

Both POST endpoints require an explicit `model` string. Omitted, null, non-string, empty, and whitespace-only values receive an OpenAI-style HTTP `400` error with `param: "model"` and `code: "invalid_model"` before Codex runs. The server trims the supplied ID and forwards it to the pinned CLI without a local allowlist. Model availability is decided by Codex and the configured account; CodexAPI has no server model default and no longer maintains or discovers a model catalog. `GET /v1/models` remains compatible and always returns `{ "object": "list", "data": [] }`. The built-in web tester requires an editable model ID.

Verified upstream rejections of the requested model (the ChatGPT-account unsupported-model message and the model-does-not-exist/no-access message) receive a sanitized HTTP `400` `invalid_model` response. Classification uses fatal CLI events or explicit error diagnostics and matches the requested ID. Unrecognized failures retain generic CLI errors; Code Mode compatibility warnings remain separate. CLI stdout, stderr, paths, URLs, and authentication details are never included in those error responses.

Reasoning effort defaults to `medium` and can be overridden by `reasoning.effort` on Responses or `reasoning_effort` on Chat Completions. Responses `text.format` supports `{ "type": "text" }`, `{ "type": "json_object" }`, and strict `{ "type": "json_schema", "name": "...", "schema": { ... } }`.

## Responses and images

Responses requests use the fixed live-search policy without a `tools` declaration. The legacy single-item `{ "tools": [{ "type": "web_search" }] }` declaration remains accepted for compatibility but does not change the available capability; other tool declarations are rejected. Chat Completions does not accept tools or `tool_choice`.

Generic Responses `input_image` compatibility supports up to two validated public HTTP(S) JPEG, PNG, or WebP images. The server sends the fixed `User-Agent: CodexAPI/0.1.0 (safe image downloader)` on every download and redirect request, follows limited redirects, enforces a timeout and size limit for each image, passes verified temporary files to Codex in request order, and removes them afterward.

If a single image cannot be prepared, the request continues with text only and a bounded diagnostic reason. Two-image requests require both images: if either fails, the server returns an OpenAI-style HTTP `422` with code `image_unavailable` without running Codex and cleans up every prepared image. The error message identifies the first failed image by its original 1-based image index and bounded reason, without exposing image URLs or temporary paths. For example:

```json
{
  "error": {
    "message": "Image 1 could not be prepared: http_status.",
    "type": "invalid_request_error",
    "param": "input",
    "code": "image_unavailable"
  }
}
```

Ludora BGG matching is separate: it supplies its public `imageUrl` as ordinary prompt text for Codex to open and compare, rather than using `input_image` transport.

## Examples

Responses research with no tools declaration (live search is already enabled):

```bash
curl http://127.0.0.1:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-terra",
    "input": "Find the BoardGameGeek entry for Coffee Rush and cite its official page."
  }'
```

Generic two-image `input_image` compatibility:

```json
{
  "model": "gpt-5.6-terra",
  "input": [{
    "role": "user",
    "content": [
      { "type": "input_text", "text": "Compare these game covers." },
      { "type": "input_image", "image_url": "https://images.example.test/store-cover.webp", "detail": "high" },
      { "type": "input_image", "image_url": "https://images.example.test/catalog-cover.webp", "detail": "high" }
    ]
  }]
}
```

BGG matching prompt text:

```json
{
  "model": "gpt-5.6-terra",
  "input": "Match this item to BoardGameGeek. itemName: Coffee Rush; imageUrl: https://images.example.test/cover.webp"
}
```

## Development

```bash
npm test
npm run typecheck
npm run build
```

The real CLI tests verify its exact version, required features, prohibited shell features, and rejection of unenforced unified execution on an ordinary host. Linux release gates must additionally set `CODEXAPI_TEST_REQUIRE_MANAGED_POLICY=1` inside a transient systemd namespace with `deploy/codex-managed` bound read-only to `/etc/codex`. This test-only setting requires successful startup attestation and verifies that `--enable unified_exec` cannot override managed requirements. It is never a server configuration setting. Use the sibling production runbook at `C:\PROJECTS\ludora\ludora-admin\docs\production-deployment.md` (VM: `/opt/ludora/ludora-admin/docs/production-deployment.md`) for the namespace command and deployment verification.

Call logging can contain prompts and responses. Keep it off unless local diagnosis specifically requires it.
