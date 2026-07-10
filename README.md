# codexapi

A local OpenAI-compatible HTTP wrapper for one-shot Codex prompts.

By default, the service exposes a small non-streaming subset of the OpenAI API and runs each request through:

```bash
codex exec - --json --skip-git-repo-check --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox --model <request.model> -c model_reasoning_effort="medium" --ignore-user-config --disable plugins --disable shell_snapshot --ephemeral --ignore-rules
```

For local development, it can also use an experimental warm `codex app-server` backend to avoid spawning `codex exec` for every request.

## Requirements

- Node.js 20 or newer
- A working local `codex` CLI on `PATH`

## Install

```bash
npm install
```

## Configure

Runtime configuration is read from environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind host |
| `PORT` | `3001` | HTTP bind port |
| `CODEX_BACKEND` | `exec` | Runner backend. Use `exec` or experimental `app-server` |
| `CODEX_WORKSPACE` | current working directory | Fixed workspace root for every Codex run |
| `CODEX_COMMAND` | npm Codex Node script on Windows, `codex` elsewhere | Codex executable |
| `CODEX_COMMAND_ARGS` | npm Codex script path on Windows, empty elsewhere | Semicolon-separated fixed args inserted before `exec` |
| `CODEX_PROFILE` | `plain` | Codex CLI profile, used only when `CODEX_IGNORE_USER_CONFIG=false` |
| `CODEX_IGNORE_USER_CONFIG` | `true` | Add `--ignore-user-config` and omit `--profile` for API-launched Codex runs |
| `CODEX_DISABLE_PLUGINS` | `true` | Add `--disable plugins` to API-launched Codex runs to avoid plugin-provided skills and plugin startup prompts |
| `CODEX_DISABLE_SHELL_SNAPSHOT` | `true` | Add `--disable shell_snapshot` to reduce shell startup work |
| `CODEX_EPHEMERAL` | `true` | Add `--ephemeral` to avoid persisting one-shot session files |
| `CODEX_IGNORE_RULES` | `true` | Add `--ignore-rules` to skip user/project execpolicy rule loading |
| `CODEX_TIMEOUT_MS` | `120000` | Per-request Codex timeout |
| `CODEX_DEFAULT_MODEL` | `gpt-5.4-mini` | Fallback Codex model when request-body `model` is absent or blank |
| `CODEX_ALLOWED_MODELS` | `gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini,gpt-5.3-codex-spark` | Comma- or semicolon-separated model ids accepted from request bodies and returned by `/v1/models` |
| `CODEX_REASONING_EFFORT` | `medium` | Default reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` |
| `CODEX_APP_SERVER_URL` | unset | Existing app-server WebSocket URL to use when `CODEX_BACKEND=app-server` |
| `CODEX_APP_SERVER_PORT` | `0` | Managed app-server port. `0` picks a free local port |
| `CODEX_APP_SERVER_START_TIMEOUT_MS` | `10000` | Timeout for connecting to app-server |
| `CODEX_APP_SERVER_DISABLE_APPS` | `true` | Start managed app-server with `--disable apps` |
| `CODEX_APP_SERVER_DISABLE_NODE_REPL_MCP` | `true` | Start managed app-server with `-c mcp_servers.node_repl.enabled=false` |
| `CODEX_CALL_LOGGING` | `false` | Write every chat/responses call to JSONL when set to `true` |
| `CODEX_CALL_LOG_DIR` | `.codexapi/logs` | Directory for `calls.jsonl` when call logging is enabled |

Example PowerShell setup:

```powershell
$env:CODEX_WORKSPACE = "C:\PROJECTS\codexapi"
npm run dev
```

## Run

```bash
npm run dev
```

Build and run compiled JavaScript:

```bash
npm run build
npm start
```

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Streaming is not supported. Requests with `stream: true` return an OpenAI-style `400` error.

For API-to-Codex calls, the wrapper passes the caller's request-body `model` through to Codex only when it appears in `CODEX_ALLOWED_MODELS`. If `model` is absent or blank, the wrapper falls back to `CODEX_DEFAULT_MODEL`, which defaults to `gpt-5.4-mini`. If a caller provides a model that is not allowlisted, the API returns a 400 `invalid_request_error` with `param: "model"` and does not invoke Codex. `/v1/models`, response bodies, and call logs all report the same resolved model.

`CODEX_REASONING_EFFORT` defaults to `medium`. Callers can override it with `reasoning.effort` on `/v1/responses` or `reasoning_effort` on `/v1/chat/completions`. Invalid values return a 400 error before Codex is invoked.

## Structured Outputs

`POST /v1/responses` supports the Responses API `text.format` field for:

- `{ "type": "text" }`
- `{ "type": "json_object" }`
- `{ "type": "json_schema", "name": "...", "strict": true, "schema": { ... } }`

With the default `exec` backend, the service writes the schema to a temporary file and passes it through Codex's native `--output-schema` option. The temporary file is removed after the command finishes. The service also extracts the returned JSON, validates it again, and returns minified JSON in `output_text`.

With `CODEX_BACKEND=app-server`, the service also passes `text.format.schema` to `turn/start` as `outputSchema` when a JSON schema is supplied. The same local extraction and validation still runs before the HTTP response is returned.

The `json_schema` validator uses Ajv's JSON Schema 2020 implementation, including composition, references, enums, and value constraints.

## Codex Profiles And Plugins

When `CODEX_IGNORE_USER_CONFIG=false`, `CODEX_PROFILE=plain` passes `--profile plain`, which layers `$CODEX_HOME/plain.config.toml` on top of the base Codex config. Profiles do not automatically disable plugins unless the profile or command disables the `plugins` feature.

By default this API passes `--ignore-user-config`, `--disable plugins`, `--disable shell_snapshot`, `--ephemeral`, and `--ignore-rules`. This avoids user config, plugin-provided skills such as `superpowers`, shell snapshotting, session persistence, and rule loading for one-shot API calls while leaving the normal Codex CLI configuration untouched. Set the corresponding `CODEX_*` variable to `false` only if you intentionally want that Codex behavior for API calls.

## Experimental App-Server Backend

Set `CODEX_BACKEND=app-server` to use a warm `codex app-server` process instead of spawning `codex exec` per request.

When `CODEX_APP_SERVER_URL` is unset, the API starts and reuses a managed local app-server:

```bash
codex app-server --listen ws://127.0.0.1:<port> --disable apps --disable plugins --disable shell_snapshot -c mcp_servers.node_repl.enabled=false
```

Each API request opens a WebSocket connection, creates one ephemeral thread, starts one turn, collects the final assistant message from app-server notifications, and returns it through the OpenAI-compatible response shape.

Current caveats:

- Codex documents the app-server WebSocket transport as experimental.
- `--ignore-user-config` and `--ignore-rules` are `codex exec` flags, not app-server flags. The managed app-server disables apps, plugins, shell snapshot, and the configured `node_repl` MCP server by default, but it can still load instruction sources from the active Codex home.
- A fully isolated `CODEX_HOME` prevents inherited instructions and MCP/plugin config, but it also needs a separate auth setup.
- Call logs show the app-server command or external WebSocket URL instead of a per-request `codex exec "<prompt>"` command.

## Call Logs

Set `CODEX_CALL_LOGGING=true` to write every `/v1/chat/completions` and `/v1/responses` call to `calls.jsonl` under `CODEX_CALL_LOG_DIR`.

Each log entry includes the request body, generated Codex prompt, Codex command details (`executable`, `args`, `cwd`, and `shell`), raw Codex stdout, raw Codex stderr, normalized output text, duration, status code, and error details when present. Exec-backend stdout is Codex JSONL, which also supplies real token usage for compatibility responses. Logs can contain sensitive prompt, tool, and response data, so keep them disabled outside local debugging.

## Examples

Chat Completions:

```bash
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [
      { "role": "user", "content": "Hello" }
    ]
  }'
```

Responses:

```bash
curl http://127.0.0.1:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "reasoning": { "effort": "medium" },
    "instructions": "Be concise.",
    "input": "Hello"
  }'
```

Responses with JSON schema:

```bash
curl http://127.0.0.1:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "input": "Translate hello to Spanish.",
    "text": {
      "format": {
        "type": "json_schema",
        "name": "translation_result",
        "strict": true,
        "schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "translatedText": { "type": "string" },
            "alternates": {
              "type": "array",
              "items": { "type": "string" }
            }
          },
          "required": ["translatedText", "alternates"]
        }
      }
    }
  }'
```

## Development

```bash
npm test
npm run typecheck
npm run build
```
