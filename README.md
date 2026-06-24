# codexapi

A local OpenAI-compatible HTTP wrapper for one-shot Codex CLI prompts.

The service exposes a small non-streaming subset of the OpenAI API and runs each request through:

```bash
codex exec "<prompt>" --skip-git-repo-check --profile plain
```

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
| `PORT` | `3000` | HTTP bind port |
| `CODEX_WORKSPACE` | current working directory | Fixed workspace root for every Codex run |
| `CODEX_COMMAND` | npm Codex Node script on Windows, `codex` elsewhere | Codex executable |
| `CODEX_COMMAND_ARGS` | npm Codex script path on Windows, empty elsewhere | Semicolon-separated fixed args inserted before `exec` |
| `CODEX_PROFILE` | `plain` | Codex CLI profile |
| `CODEX_TIMEOUT_MS` | `120000` | Per-request Codex timeout |
| `OPENAI_COMPAT_MODEL` | `local-codex` | Model name returned by compatibility responses |
| `CODEX_CALL_LOGGING` | `false` | Write every chat/responses call to JSONL when set to `true` |
| `CODEX_CALL_LOG_DIR` | `.codexapi/logs` | Directory for `calls.jsonl` when call logging is enabled |

Example PowerShell setup:

```powershell
$env:CODEX_WORKSPACE = "C:\PROJECTS\codexapi"
$env:OPENAI_COMPAT_MODEL = "local-codex"
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

## Structured Outputs

`POST /v1/responses` supports the Responses API `text.format` field for:

- `{ "type": "text" }`
- `{ "type": "json_object" }`
- `{ "type": "json_schema", "name": "...", "strict": true, "schema": { ... } }`

Structured output is prompt-enforced because Codex CLI does not expose native constrained decoding. The service asks Codex to return only JSON, extracts the first JSON object from the output, validates it, and returns minified JSON in `output_text`.

The `json_schema` validator supports a practical subset: `type`, `properties`, `required`, `items`, `additionalProperties: false`, nested objects, arrays, and primitive string/number/integer/boolean/null types.

## Call Logs

Set `CODEX_CALL_LOGGING=true` to write every `/v1/chat/completions` and `/v1/responses` call to `calls.jsonl` under `CODEX_CALL_LOG_DIR`.

Each log entry includes the request body, generated Codex prompt, raw Codex stdout, raw Codex stderr, normalized output text, duration, status code, and error details when present. This can include sensitive prompt and response data, so keep it disabled outside local debugging.

## Examples

Chat Completions:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local-codex",
    "messages": [
      { "role": "user", "content": "Hello" }
    ]
  }'
```

Responses:

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local-codex",
    "instructions": "Be concise.",
    "input": "Hello"
  }'
```

Responses with JSON schema:

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local-codex",
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
