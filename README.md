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
| `CODEX_COMMAND` | `codex` | Codex executable |
| `CODEX_PROFILE` | `plain` | Codex CLI profile |
| `CODEX_TIMEOUT_MS` | `120000` | Per-request Codex timeout |
| `OPENAI_COMPAT_MODEL` | `local-codex` | Model name returned by compatibility responses |

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

## Development

```bash
npm test
npm run typecheck
npm run build
```

