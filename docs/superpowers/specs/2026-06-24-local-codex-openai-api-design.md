# Local Codex OpenAI-Compatible API Design

## Goal

Create a local HTTP API that lets projects call a local Codex CLI one-shot execution flow through a small OpenAI-compatible subset. The first version supports non-streaming `/v1/chat/completions` and `/v1/responses` requests, both backed by `codex exec`.

## Scope

The service will be a Node.js/TypeScript Fastify application. It will expose:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

The service will run each prompt in one fixed workspace root. Per-request working directories are intentionally out of scope for the first version.

Streaming is not supported. Requests with `stream: true` will receive a `400` OpenAI-style error.

## Runtime Configuration

Configuration comes from environment variables with defaults:

- `HOST`: bind host, default `127.0.0.1`
- `PORT`: bind port, default `3001`
- `CODEX_WORKSPACE`: fixed workspace root, default to the current process working directory
- `CODEX_COMMAND`: Codex executable, default `codex`
- `CODEX_PROFILE`: Codex profile, default `plain`
- `CODEX_TIMEOUT_MS`: process timeout, default `120000`
- `OPENAI_COMPAT_MODEL`: model name advertised and echoed by responses, default `local-codex`

The Codex command will run as:

```text
codex exec <prompt> --skip-git-repo-check --profile <CODEX_PROFILE>
```

The implementation will use `child_process.spawn` with an argument array, not shell string interpolation.

## Request Mapping

### Chat Completions

`POST /v1/chat/completions` accepts:

- `model`
- `messages`
- common optional OpenAI fields, including `temperature`, `top_p`, `max_tokens`, and `stream`

The required behavior is:

- Validate that `messages` is a non-empty array.
- Convert messages into a plain transcript prompt.
- Preserve role labels in the prompt, such as `system:`, `user:`, and `assistant:`.
- Accept unsupported generation options but ignore them.
- Reject `stream: true`.

Example prompt:

```text
system: You are concise.
user: Hello
assistant:
```

### Responses

`POST /v1/responses` accepts:

- `model`
- `input`
- common optional OpenAI fields, including `instructions`, `temperature`, `top_p`, `max_output_tokens`, and `stream`

The required behavior is:

- Validate that `input` exists.
- Use string input directly.
- Normalize array input into readable text.
- Prefix `instructions` when present.
- Accept unsupported generation options but ignore them.
- Reject `stream: true`.

## Response Mapping

### Chat Completions

The response will be shaped like:

```json
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "local-codex",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Codex output"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

### Responses

The response will include:

- `id`
- `object: "response"`
- `created_at`
- `model`
- `status: "completed"`
- `output_text`
- one assistant message output item containing the Codex output
- zeroed `usage`

## Error Handling

Errors will use an OpenAI-style JSON shape:

```json
{
  "error": {
    "message": "Human readable message",
    "type": "invalid_request_error",
    "param": "stream",
    "code": "unsupported_streaming"
  }
}
```

Expected error cases:

- invalid request body
- unsupported streaming
- Codex executable not found
- Codex non-zero exit
- Codex timeout
- unexpected internal error

Codex stderr will be included in error messages only when it is useful and bounded.

## Testing

The implementation will use automated tests before production code. Tests will cover:

- chat message normalization
- responses input normalization
- stream rejection for both endpoints
- Codex runner argument construction
- Codex runner timeout and non-zero exit behavior
- HTTP response shape for both endpoints using a fake Codex runner
- `/v1/models` response shape

## Non-Goals

The first version will not support:

- streaming/SSE
- tool calls
- OpenAI function calling
- image/audio input
- per-request workspace roots
- token counting
- honoring sampling parameters
- conversation persistence
