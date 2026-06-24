# Local Codex OpenAI API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js/TypeScript Fastify API that exposes non-streaming OpenAI-compatible `/v1/chat/completions` and `/v1/responses` endpoints backed by local `codex exec`.

**Architecture:** Keep the system split into small modules: configuration loading, Codex process execution, OpenAI compatibility mapping, and Fastify route wiring. Tests use Vitest and inject a fake Codex runner for HTTP behavior.

**Tech Stack:** Node.js, TypeScript, Fastify, Vitest, tsx.

---

## File Structure

- `package.json`: npm scripts and dependencies.
- `tsconfig.json`: strict TypeScript project settings.
- `.env.example`: documented runtime configuration.
- `.gitignore`: dependency/build/environment ignores.
- `src/config.ts`: environment parsing and defaults.
- `src/codexRunner.ts`: spawn-based Codex CLI execution.
- `src/openaiCompat.ts`: prompt normalization and response/error shaping.
- `src/server.ts`: Fastify application factory and executable server entry point.
- `test/openaiCompat.test.ts`: request normalization and response mapping tests.
- `test/codexRunner.test.ts`: process execution behavior tests with a temporary fake Codex executable.
- `test/server.test.ts`: route tests using Fastify injection and a fake runner.

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Create package and TypeScript config**

Create the npm project with scripts:

```json
{
  "name": "codexapi",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@fastify/cors": "^11.0.0",
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`

Expected: dependencies install and `package-lock.json` is created.

- [ ] **Step 3: Commit scaffold**

Run:

```bash
git add package.json package-lock.json tsconfig.json .env.example .gitignore
git commit -m "chore: scaffold typescript service"
```

### Task 2: OpenAI Compatibility Mapping

**Files:**
- Create: `src/openaiCompat.ts`
- Test: `test/openaiCompat.test.ts`

- [ ] **Step 1: Write failing mapping tests**

Tests must cover:

- chat messages convert to a role-labeled prompt ending with `assistant:`
- `stream: true` is rejected for chat and responses
- responses string input passes through
- responses array input is normalized
- chat and response objects include zeroed usage and expected object fields

- [ ] **Step 2: Run mapping tests to verify failure**

Run: `npm test -- test/openaiCompat.test.ts`

Expected: FAIL because `src/openaiCompat.ts` does not exist.

- [ ] **Step 3: Implement minimal mapping code**

Export functions for:

- `buildChatPrompt(body)`
- `buildResponsesPrompt(body)`
- `createChatCompletion({ model, content })`
- `createResponse({ model, content })`
- `openAiError(message, type, param, code, statusCode)`

- [ ] **Step 4: Run mapping tests to verify pass**

Run: `npm test -- test/openaiCompat.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit mapping**

Run:

```bash
git add src/openaiCompat.ts test/openaiCompat.test.ts
git commit -m "feat: add openai compatibility mapping"
```

### Task 3: Codex Runner

**Files:**
- Create: `src/codexRunner.ts`
- Test: `test/codexRunner.test.ts`

- [ ] **Step 1: Write failing runner tests**

Tests must cover:

- runner invokes command with arguments `exec`, prompt, `--skip-git-repo-check`, `--profile`, profile
- runner returns stdout on exit code `0`
- runner rejects with a typed error on non-zero exit
- runner rejects with a typed timeout error and kills the process

- [ ] **Step 2: Run runner tests to verify failure**

Run: `npm test -- test/codexRunner.test.ts`

Expected: FAIL because `src/codexRunner.ts` does not exist.

- [ ] **Step 3: Implement spawn-based runner**

Use `child_process.spawn` with `shell: false`, bounded stdout/stderr collection, and timeout handling.

- [ ] **Step 4: Run runner tests to verify pass**

Run: `npm test -- test/codexRunner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit runner**

Run:

```bash
git add src/codexRunner.ts test/codexRunner.test.ts
git commit -m "feat: run codex cli prompts"
```

### Task 4: Fastify Server

**Files:**
- Create: `src/config.ts`
- Create: `src/server.ts`
- Test: `test/server.test.ts`

- [ ] **Step 1: Write failing route tests**

Tests must cover:

- `GET /health` returns `{ "status": "ok" }`
- `GET /v1/models` returns a model list containing the configured model
- `POST /v1/chat/completions` calls the runner and returns chat completion JSON
- `POST /v1/responses` calls the runner and returns response JSON with `output_text`
- both endpoints reject `stream: true`
- runner failures return OpenAI-style error JSON

- [ ] **Step 2: Run route tests to verify failure**

Run: `npm test -- test/server.test.ts`

Expected: FAIL because `src/server.ts` does not exist.

- [ ] **Step 3: Implement config and Fastify app factory**

Export `createServer(options)` for tests and start listening only when `src/server.ts` is run as the entry point.

- [ ] **Step 4: Run route tests to verify pass**

Run: `npm test -- test/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit server**

Run:

```bash
git add src/config.ts src/server.ts test/server.test.ts
git commit -m "feat: expose openai compatible routes"
```

### Task 5: Final Verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Add concise README usage**

Document install, dev server, environment variables, and example curl calls for both endpoints.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all commands exit `0`.

- [ ] **Step 3: Commit docs and final fixes**

Run:

```bash
git add README.md docs/superpowers/plans/2026-06-24-local-codex-openai-api.md
git commit -m "docs: add local api usage"
```

- [ ] **Step 4: Push branch**

Run: `git push -u origin feat/local-codex-openai-api`

Expected: branch is pushed to origin.
