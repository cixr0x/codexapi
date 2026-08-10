# Capability-Constrained CodexAPI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every CodexAPI request safe for attacker-controlled input while preserving text/structured-output callers and adding explicit public-web search plus safely attached store-cover images for Ludora's BGG matcher.

**Architecture:** CodexAPI will expose one fixed `codex exec` execution policy: read-only, approval-free, ephemeral, isolated workspace, host-capable features disabled, and web search enabled only by the supported Responses tool declaration. A dedicated image-fetch boundary validates and pins public HTTP(S) destinations, verifies image bytes, creates a temporary attachment, and always removes it. Ludora opts the BGG matcher into web search and image input, then hardens cache identity, transactionality, semantic validation, and trace evidence.

**Tech Stack:** Node.js 20+, TypeScript, Fastify 5, Vitest 3, exact security pin Codex CLI 0.147.0, OpenAI Node SDK, PostgreSQL client transactions, Python unittest.

## Global Constraints

- Treat every HTTP request, prompt, store title, URL, remote page, and image as attacker-controlled.
- Support only the `codex exec` backend; there is no privileged or app-server mode.
- Every Codex run uses sandbox `read-only`, approval policy `never`, ignored user configuration/rules, ephemeral state, and a fixed empty inference workspace.
- Disable shell/process execution, local-image viewing, apps, plugins, MCP, shell snapshot, browser/computer use, code execution, image generation, delegation, memories, hooks, and tool discovery.
- `/v1/chat/completions` is text-only. `/v1/responses` accepts no tools or exactly `[{ "type": "web_search" }]`; malformed, duplicate, or unsupported tools fail with `400 invalid_request_error` before spawning Codex.
- Remote images are optional and name-only matching continues after a bounded fetch failure. Accept at most one JPEG, PNG, or WebP from public HTTP(S), ports 80/443, at most three validated redirects, 10 seconds, and 8 MiB.
- No request field or environment variable may broaden capabilities.
- Do not start, stop, or move the existing local service on fixed port 3001. Preserve `.codexapi-server.err.log`, `.codexapi-server.out.log`, and `.codexapi/logs` as uncommitted runtime artifacts.
- Do not deploy, modify production identities, or execute database DDL/DML in this implementation session.
- Use separate commits in `C:\PROJECTS\codexapi` and `C:\PROJECTS\ludora\ludora-admin\.worktrees\ai-bgg-matching`; never combine repository histories.

## File Responsibility Map

### CodexAPI

- Create `src/executionPolicy.ts`: immutable safe policy, request capability types, health projection, and unsafe-config validation.
- Create `src/codexCapabilityCheck.ts`: exact-version and complete feature-output parsing plus startup fail-closed probe.
- Create `src/safeRemoteImage.ts`: URL validation, DNS classification, pinned HTTP(S) fetch, byte/MIME validation, redirect handling, and temporary-file cleanup contract.
- Modify `src/codexRunner.ts`: consume the fixed policy and per-request `webSearch`/`imagePaths`; assemble constrained `codex exec` arguments only.
- Modify `src/openaiCompat.ts`: return a normalized Responses request containing prompt, web-search opt-in, and at most one image URL; keep chat text-only.
- Modify `src/server.ts`: reject unsafe tools before runner invocation, obtain/cleanup optional image attachment, expose policy health, and run the startup capability check.
- Modify `src/config.ts`: remove app-server and capability-broadening flags; require a safe inference workspace.
- Delete `src/appServerRunner.ts` and `test/appServerRunner.test.ts`: remove the unsupported backend and its privileged surface.
- Create `test/executionPolicy.test.ts`, `test/codexCapabilityCheck.test.ts`, and `test/safeRemoteImage.test.ts`; update runner/config/compat/server tests.
- Modify `.env.example`, `README.md`, and `AGENTS.md`: document the fixed policy, caller tool contract, workspace requirements, version probe, and dedicated production identity.

### Ludora admin feature worktree

- Modify `ludora-admin-service/src/ai/codexResponsesClient.ts`: set OpenAI SDK `maxRetries: 0` globally.
- Modify `ludora-admin-service/src/aiBggMatching/codexAiBggMatchingClient.ts`: request web search, attach the nullable cover, and reject inconsistent negative decisions.
- Modify `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.ts`: preserve strict positive/no-match normalization.
- Modify `ludora-admin-service/src/bgg/bggMatchCache.ts`: represent cover-aware trust and write AI associations atomically on one database session.
- Modify `ludora-admin-service/src/itemMatching/itemMatchingService.ts`: pass cover context into cache lookup/write, add decision evidence to traces, and preserve import/link semantics.
- Update colocated tests for all modules above plus `ludora-discovery/tests/test_admin_matching.py` where legacy base-URL behavior is covered.
- Modify `docs/production-deployment.md`: document the future dedicated `codexapi` identity and hardened systemd unit without applying it.

---

### Task 1: Fix the CodexAPI execution policy and remove app-server

**Files:**
- Create: `src/executionPolicy.ts`
- Modify: `src/codexRunner.ts`
- Modify: `src/config.ts`
- Modify: `src/server.ts`
- Delete: `src/appServerRunner.ts`
- Test: `test/executionPolicy.test.ts`
- Test: `test/codexRunner.test.ts`
- Test: `test/config.test.ts`
- Delete: `test/appServerRunner.test.ts`

**Interfaces:**
- Produces: `CodexRequestCapabilities { webSearch: boolean; imagePaths: readonly string[] }`.
- Produces: `assertSafeExecutionConfig(config: Pick<AppConfig, "codexWorkspace">): void` and `executionPolicyHealth()`.
- Changes: `CodexRunOptions` gains `webSearch?: boolean` and `imagePaths?: readonly string[]`.
- Requires later callers to pass only normalized booleans and locally created attachment paths.

- [ ] **Step 1: Write failing policy and runner tests**

Add assertions that a default run contains `--sandbox read-only`, `-c approval_policy="never"`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, and every required `--disable` pair; assert it omits `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, and `--profile`. Add cases for `webSearch: false`, `webSearch: true`, and two `--image <absolute-temp-path>` values. Add config tests proving `CODEX_BACKEND=app-server` and a workspace equal to the repository/current working directory are rejected.

- [ ] **Step 2: Run focused tests and verify the unsafe current behavior fails**

Run: `npm test -- --run test/codexRunner.test.ts test/config.test.ts test/executionPolicy.test.ts`

Expected: FAIL because the current runner emits full-access/bypass arguments, supports app-server, and has no policy module.

- [ ] **Step 3: Implement the immutable execution policy**

Create the policy with explicit values, not environment-derived switches:

```ts
export interface CodexRequestCapabilities {
  webSearch: boolean;
  imagePaths: readonly string[];
}

export const CODEX_EXECUTION_POLICY = Object.freeze({
  backend: "exec" as const,
  sandbox: "read-only" as const,
  approvalPolicy: "never" as const,
  disabledFeatures: Object.freeze([
    "shell_tool", "apps", "plugins", "shell_snapshot", "browser",
    "computer_use", "code_mode", "image_generation", "multi_agent",
    "memories", "hooks", "tool_discovery",
  ]),
  ignoreUserConfig: true,
  ignoreRules: true,
  ephemeral: true,
});
```

Export `executionPolicyHealth()` as a JSON-safe projection. Reject blank/non-absolute workspaces and a workspace resolving to the CodexAPI checkout or its parent; permit only the configured dedicated inference directory. Remove app-server parsing and construction. Delete the app-server implementation/tests.

- [ ] **Step 4: Assemble constrained `codex exec` arguments**

Build arguments from constants plus `CodexRunOptions`:

```ts
const args = [
  ...commandArgs,
  "exec", "-", "--json", "--skip-git-repo-check",
  "--sandbox", "read-only",
  "-c", 'approval_policy="never"',
  "--ignore-user-config", "--ignore-rules", "--ephemeral",
  ...CODEX_EXECUTION_POLICY.disabledFeatures.flatMap((name) => ["--disable", name]),
  "-c", `web_search=${options.webSearch ? '"live"' : '"disabled"'}`,
  ...(options.webSearch ? ["-c", "tools.web_search=true"] : []),
  ...options.imagePaths.flatMap((path) => ["--image", path]),
];
```

Keep model, reasoning effort, and output schema support. Ensure no config or request can append arbitrary runner flags.

- [ ] **Step 5: Run the focused tests and typecheck**

Run: `npm test -- --run test/codexRunner.test.ts test/config.test.ts test/executionPolicy.test.ts`

Run: `npm run typecheck`

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the constrained runner**

```powershell
git add src/executionPolicy.ts src/codexRunner.ts src/config.ts src/server.ts test/executionPolicy.test.ts test/codexRunner.test.ts test/config.test.ts src/appServerRunner.ts test/appServerRunner.test.ts
git commit -m "security: constrain CodexAPI execution"
```

### Task 2: Enforce the HTTP tool contract and policy health

**Files:**
- Modify: `src/openaiCompat.ts`
- Modify: `src/server.ts`
- Modify: `src/callLogger.ts`
- Test: `test/openaiCompat.test.ts`
- Test: `test/server.test.ts`
- Test: `test/callLogger.test.ts`

**Interfaces:**
- Produces: `NormalizedResponsesRequest { prompt: string; webSearch: boolean; imageUrl: string | null }` from `normalizeResponsesRequest(body: unknown)`.
- Consumes: `CodexRunOptions.webSearch` from Task 1.
- Keeps: `buildResponsesPrompt(body)` as a compatibility wrapper returning `.prompt` for existing tests/call sites that do not need capabilities.

- [ ] **Step 1: Write failing contract tests**

Cover these exact inputs: absent tools; `tools: []`; `[{type:"web_search"}]`; duplicate web search; `web_search_preview`; function; shell; malformed/non-array tools; `tool_choice:"auto"`; absent tool choice; `tool_choice:"required"`; chat request with any `tools`. Assert unsupported cases return status 400, body type `invalid_request_error`, the relevant `param`, and zero runner calls. Assert `/health` contains the fixed policy and no sensitive paths.

- [ ] **Step 2: Run contract tests and verify red**

Run: `npm test -- --run test/openaiCompat.test.ts test/server.test.ts test/callLogger.test.ts`

Expected: FAIL because tools are currently ignored and health only reports `{ status: "ok" }`.

- [ ] **Step 3: Normalize Responses capabilities before prompt construction**

Implement exact acceptance:

```ts
export interface NormalizedResponsesRequest {
  prompt: string;
  webSearch: boolean;
  imageUrl: string | null;
}

function parseWebSearch(body: Record<string, unknown>): boolean {
  if (body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0)) return false;
  if (!Array.isArray(body.tools) || body.tools.length !== 1 ||
      !isPlainObject(body.tools[0]) ||
      Object.keys(body.tools[0]).length !== 1 ||
      body.tools[0].type !== "web_search") {
    throw new OpenAIHttpError("Only one web_search tool is supported.", 400, "invalid_request_error", "tools");
  }
  if (body.tool_choice !== undefined && body.tool_choice !== "auto") {
    throw new OpenAIHttpError('tool_choice must be "auto".', 400, "invalid_request_error", "tool_choice");
  }
  return true;
}
```

Reject any chat `tools` or `tool_choice`. Return the normalized request before invoking Codex.

- [ ] **Step 4: Route normalized capabilities and bounded logs**

Pass `{ model, reasoningEffort, outputSchema, webSearch, imagePaths: [] }` to the runner. Add `webSearchEnabled` and the bounded image diagnostic code to call logs, but never log downloaded bytes, local temp paths, URL credentials, or DNS results. Return `executionPolicyHealth()` from `/health`.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- --run test/openaiCompat.test.ts test/server.test.ts test/callLogger.test.ts`

Run: `npm run typecheck`

Expected: all selected tests pass.

```powershell
git add src/openaiCompat.ts src/server.ts src/callLogger.ts test/openaiCompat.test.ts test/server.test.ts test/callLogger.test.ts
git commit -m "security: enforce CodexAPI tool contract"
```

### Task 3: Safely fetch and attach caller images

**Files:**
- Create: `src/safeRemoteImage.ts`
- Modify: `src/openaiCompat.ts`
- Modify: `src/server.ts`
- Test: `test/safeRemoteImage.test.ts`
- Test: `test/openaiCompat.test.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Produces: `prepareRemoteImage(url, dependencies?): Promise<PreparedRemoteImage>`.
- Produces: `PreparedRemoteImage { path: string | null; reason: SafeImageReason | null; cleanup(): Promise<void> }`.
- `SafeImageReason` is a closed union: `invalid_url | credentials | unsupported_scheme | unsupported_port | dns_failed | non_public_address | redirect_limit | redirect_invalid | timeout | http_status | too_large | unsupported_type | invalid_magic | fetch_failed`.
- Consumes: the single `imageUrl` extracted by `normalizeResponsesRequest` and `CodexRunOptions.imagePaths` from Task 1.

- [ ] **Step 1: Write failing URL/DNS/redirect tests**

Using injected DNS and transport fakes, test rejection of URL credentials, `file:`, non-80/443 ports, `127.0.0.1`, `0.0.0.0`, RFC1918, `169.254.169.254`, IPv6 `::1`, `fc00::/7`, `fe80::/10`, multicast/reserved addresses, and any mixed public/private DNS answer. Test that each redirect is re-resolved, four redirects fail, request headers contain only a generated `Host`/minimal accept header, and the connection lookup returns the prevalidated IP to prevent DNS rebinding.

- [ ] **Step 2: Write failing byte/cleanup tests**

Cover JPEG, PNG, and WebP MIME plus magic success; MIME/magic mismatch; unsupported MIME; declared and streamed sizes above 8 MiB; 10-second abort; non-2xx status; cleanup after success, runner error, structured-output error, and request cancellation. Assert all failures return `path: null` with a closed reason and do not throw into the matching request.

- [ ] **Step 3: Run image tests and verify red**

Run: `npm test -- --run test/safeRemoteImage.test.ts test/openaiCompat.test.ts test/server.test.ts`

Expected: FAIL because the safe fetcher and image extraction do not exist.

- [ ] **Step 4: Implement destination validation and pinned fetch**

Use `dns.promises.lookup(host, { all: true, verbatim: true })`, `net.BlockList` plus explicit IPv4/IPv6 CIDR coverage, and reject when any answer is non-public. Construct `http.request`/`https.request` with the original hostname for `Host` and TLS `servername`, but inject a custom `lookup` callback that returns only the selected validated address. Re-run the full validation for every `Location` resolved against the prior URL. Never use ambient proxy or caller headers.

- [ ] **Step 5: Implement verified temporary attachments**

Stream to a directory from `mkdtemp(join(tmpdir(), "codexapi-image-"))`, stop after `8 * 1024 * 1024` bytes, verify the first bytes against JPEG `ffd8ff`, PNG `89504e470d0a1a0a`, or WebP `RIFF....WEBP`, and write an extension selected from verified bytes. Return an idempotent cleanup that recursively removes only the created temp directory.

- [ ] **Step 6: Extract at most one Responses `input_image` and integrate cleanup**

Accept an `input_image` only inside Responses input content and only when `image_url` is a string. Reject a second image or non-URL image source with `400 invalid_request_error`. Keep the URL as prompt data and replace the content rendering with a fixed `[store cover attached when available]` marker. In the server:

```ts
const prepared = normalized.imageUrl
  ? await prepareRemoteImage(normalized.imageUrl)
  : emptyPreparedRemoteImage();
try {
  return await invokeRunner(normalized.prompt, {
    ...options,
    webSearch: normalized.webSearch,
    imagePaths: prepared.path ? [prepared.path] : [],
  });
} finally {
  await prepared.cleanup();
}
```

Continue the request name-only when `prepared.path` is null and record only `prepared.reason`.

- [ ] **Step 7: Run focused tests, typecheck, and commit**

Run: `npm test -- --run test/safeRemoteImage.test.ts test/openaiCompat.test.ts test/server.test.ts`

Run: `npm run typecheck`

Expected: all selected tests pass.

```powershell
git add src/safeRemoteImage.ts src/openaiCompat.ts src/server.ts test/safeRemoteImage.test.ts test/openaiCompat.test.ts test/server.test.ts
git commit -m "security: validate CodexAPI image attachments"
```

### Task 4: Fail startup on incompatible Codex CLI and document local policy

**Files:**
- Create: `src/codexCapabilityCheck.ts`
- Modify: `src/server.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Test: `test/codexCapabilityCheck.test.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Produces: `assertCodexCapabilities(config, spawn?): Promise<CodexCapabilityReport>`.
- Produces: `CodexCapabilityReport { version: string; shellToolFeature: "stable" | "experimental"; checked: true }`.
- Startup invokes the check before `listen`; tests that inject a fake runner do not require a local CLI.

- [ ] **Step 1: Write failing version/feature probe tests**

Test exact `codex-cli 0.147.0` as accepted; older/newer versions, unparsable output, nonzero version command, missing or enabled fixed-disabled rows (including `view_image`), malformed/duplicate rows, unknown maturities, and unallowlisted enabled rows as rejected. Assert `startServer()` performs the probes before calling `listen`, while `createServer({ runner })` remains deterministic for unit tests.

- [ ] **Step 2: Run tests and verify red**

Run: `npm test -- --run test/codexCapabilityCheck.test.ts test/server.test.ts`

Expected: FAIL because startup has no compatibility gate.

- [ ] **Step 3: Implement the fail-closed probe**

Run the package-local executable with `--version`, require exact `0.147.0`, then parse the complete `features list` output into unique well-formed rows. Require every fixed-disabled feature false and allow only the pinned `removed` no-op rows to remain true at their exact maturity. Bound stdout/stderr and time out the probes. On any mismatch throw before the listener binds. Include the accepted version and policy name in `/health`, not command paths or workspace paths.

- [ ] **Step 4: Rewrite local configuration documentation**

Remove all app-server, profile, and capability-toggle environment variables. Set `CODEX_WORKSPACE` to an example empty inference directory. Document the exact accepted Responses tool declaration, optional `input_image`, bounded name-only fallback, fixed port, exact CLI security pin, and that arbitrary prompts cannot use host tools. Change `AGENTS.md` from “all services run as robertorojas87” to the approved dedicated CodexAPI identity rule while leaving actual production migration to the deployment runbook.

- [ ] **Step 5: Run all CodexAPI verification and commit**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: full suite passes; typecheck/build exit 0.

```powershell
git add src/codexCapabilityCheck.ts src/server.ts test/codexCapabilityCheck.test.ts test/server.test.ts .env.example README.md AGENTS.md
git commit -m "docs: define constrained CodexAPI runtime"
```

### Task 5: Make the Ludora BGG request use the hardened contract

**Files:**
- Modify: `ludora-admin-service/src/ai/codexResponsesClient.ts`
- Modify: `ludora-admin-service/src/ai/codexResponsesClient.test.ts`
- Modify: `ludora-admin-service/src/aiBggMatching/codexAiBggMatchingClient.ts`
- Modify: `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.test.ts`
- Modify: `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.ts`

**Interfaces:**
- Shared client constructs `new OpenAI({ apiKey: "codexapi-local", baseURL, maxRetries: 0 })`.
- BGG request sends `tools: [{ type: "web_search" }]` and content parts `input_text` plus optional `input_image`.
- Dynamic prompt JSON remains exactly `{ itemName, imageUrl }`; no language field or other product data is added.

- [ ] **Step 1: Write failing transport and invariant tests**

Assert the OpenAI client has zero retries by simulating a 500 and observing one HTTP attempt. Assert a BGG request has exactly one `web_search` tool, has one `input_image` for a nonblank image URL, has no image part for null/blank URL, and still embeds only the two approved dynamic keys. Add table cases where `matchFound:false` is paired with non-null `bggId`, `matchedName`, `bggUrl`, `bggImageUrl`, `nameAssessment:"MATCH"`, or `coverAssessment:"MATCH"`; every case must reject as an invalid AI decision.

- [ ] **Step 2: Run focused tests and verify red**

Run from `ludora-admin-service`: `npm test -- --run src/ai/codexResponsesClient.test.ts src/aiBggMatching/aiBggMatchingService.test.ts`

Expected: FAIL because retries default to two, BGG does not send tool/image parts, and inconsistent negatives are accepted.

- [ ] **Step 3: Implement one-call transport and BGG request content**

Set `maxRetries: 0` in the shared client factory. Build BGG input as:

```ts
const content: OpenAI.Responses.ResponseInputContent[] = [
  { type: "input_text", text: buildAiBggMatchingUserPrompt(request) },
];
if (request.imageUrl?.trim()) {
  content.push({ type: "input_image", image_url: request.imageUrl.trim(), detail: "high" });
}
await responses.create({
  model,
  instructions: AI_BGG_MATCHING_SYSTEM_PROMPT,
  input: [{ role: "user", content }],
  tools: [{ type: "web_search" }],
  text: { format: AI_BGG_MATCHING_TEXT_FORMAT },
});
```

After parsing, require all identity fields null and assessments `NO_MATCH`/`UNAVAILABLE` when `matchFound` is false. Throw the existing invalid-decision error so the caller records `processing_error` and skips cache/import/link.

- [ ] **Step 4: Run focused tests, build, and commit**

Run: `npm test -- --run src/ai/codexResponsesClient.test.ts src/aiBggMatching/aiBggMatchingService.test.ts`

Run: `npm run build`

Expected: selected tests pass and build exits 0.

```powershell
git add src/ai/codexResponsesClient.ts src/ai/codexResponsesClient.test.ts src/aiBggMatching/codexAiBggMatchingClient.ts src/aiBggMatching/aiBggMatchingService.ts src/aiBggMatching/aiBggMatchingService.test.ts
git commit -m "fix: use hardened CodexAPI BGG contract"
```

### Task 6: Make AI cache trust cover-aware and writes atomic

**Files:**
- Modify: `ludora-admin-service/src/bgg/bggMatchCache.ts`
- Modify: `ludora-admin-service/src/bgg/bggMatchCache.test.ts`
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.ts`
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.test.ts`

**Interfaces:**
- Change lookup to `search(query: string, context?: { imageUrl: string | null }): Promise<BggCachedSearch>`.
- Change write to `recordAiMatch(queries: string[], result: BggSearchItem, context: { imageUrl: string | null }): Promise<void>`.
- Trusted association key uses normalized query plus a deterministic cover-context discriminator; `name-only` is distinct from an image URL digest.
- Database dependency must expose `connect()` so one checked-out client executes the complete transaction.

- [ ] **Step 1: Write failing trust-isolation tests**

Prove that the same normalized title and same normalized image URL reuses an AI-trusted match; same title with a different cover URL is not trusted; same title with no image is not trusted from an image-backed association; and name-only association reuses only for another missing-image candidate. Include the regression where title changes to “War of the Ring” but `coffee-rush.jpg` remains: it must call AI and must not auto-import from cache.

- [ ] **Step 2: Write failing transaction tests**

Use a fake pool/client and assert `connect`, `BEGIN`, deterministic advisory/query-key lock, cache item upsert, deletion/replacement of association rows, `COMMIT`, and `release` all occur on the same client. Inject failure after deletion and assert `ROLLBACK`, no `COMMIT`, release, and rejection. Run two controlled concurrent writes for the same trust key and assert the lock serializes replacement so no partial/duplicate trusted set is observable.

- [ ] **Step 3: Run focused tests and verify red**

Run: `npm test -- --run src/bgg/bggMatchCache.test.ts src/itemMatching/itemMatchingService.test.ts`

Expected: FAIL because trust ignores image context and writes use pool-level autocommit statements.

- [ ] **Step 4: Implement cover-context identity**

Normalize blank images to the literal discriminator `name-only`. For nonblank URLs, canonicalize the URL string without fetching it and derive a SHA-256 hex digest using `node:crypto`; combine it with the normalized query only in the existing cache association key, without schema changes. Store and query the same derived key. Do not log raw cover URLs in cache diagnostics.

- [ ] **Step 5: Implement one-session atomic replacement**

Acquire `const client = await database.connect()`, execute `BEGIN`, take `pg_advisory_xact_lock` on two stable 32-bit halves derived from the trust key, perform item upsert and association replacement through `client.query`, then `COMMIT`. On error issue `ROLLBACK` and rethrow; always `release()` in `finally`. Sort/deduplicate query keys before locking/writing to avoid lock-order inversion.

- [ ] **Step 6: Pass cover context through item matching**

Use `nonEmptyStringOrNull(candidate.image_url)` for every cache lookup and `recordAiMatch` call. A non-trusted cached result can still participate in deterministic scoring; only an exact trust-context hit receives `verifiedByAi:true` and bypasses the score threshold.

- [ ] **Step 7: Run focused tests, build, and commit**

Run: `npm test -- --run src/bgg/bggMatchCache.test.ts src/itemMatching/itemMatchingService.test.ts`

Run: `npm run build`

Expected: selected tests pass and build exits 0.

```powershell
git add src/bgg/bggMatchCache.ts src/bgg/bggMatchCache.test.ts src/itemMatching/itemMatchingService.ts src/itemMatching/itemMatchingService.test.ts
git commit -m "fix: make AI BGG cache trust cover-aware"
```

### Task 7: Restore matching regressions and trace evidence

**Files:**
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.ts`
- Modify: `ludora-admin-service/src/itemMatching/itemMatchingService.test.ts`
- Modify: `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.test.ts`
- Modify: `ludora-discovery/tests/test_admin_matching.py`

**Interfaces:**
- AI trace payload records `matched_name`, `name_assessment`, and `cover_assessment` in addition to existing decision fields.
- Admin-confirmed no-match and processing-error outcomes retain their pre-feature HTTP/job semantics.
- Candidate SQL projection must include `image_url`.

- [ ] **Step 1: Add failing regression tests**

Assert the actual candidate SQL text selects `image_url`. Assert successful, no-match, cover-conflict, malformed-decision, BGG-validation-failure, and cache-write-failure traces contain the three evidence fields or explicit nulls. Restore tests proving an admin-confirmed no-match is final and does not call AI, and a processing error does not cache/import/link. In Python, assert the discovery client still honors the legacy loopback `OPENAI_BASE_URL` normalization if that path remains in the changed classifier boundary.

- [ ] **Step 2: Run focused service and discovery tests and verify red**

Run from `ludora-admin-service`: `npm test -- --run src/itemMatching/itemMatchingService.test.ts src/aiBggMatching/aiBggMatchingService.test.ts`

Run from `ludora-discovery`: `python -m unittest tests.test_admin_matching -v`

Expected: at least the trace-evidence assertions fail before implementation.

- [ ] **Step 3: Add complete bounded trace evidence**

Map the parsed decision into snake-case trace fields at the AI-decision boundary:

```ts
{
  bgg_id: decision?.bggId ?? null,
  matched_name: decision?.matchedName ?? null,
  name_assessment: decision?.nameAssessment ?? null,
  cover_assessment: decision?.coverAssessment ?? null,
  confidence: decision?.confidence ?? null,
}
```

Do not add prompt bodies, image bytes, signed URL credentials, or model reasoning beyond the already approved bounded reason field. Preserve existing admin/job response codes.

- [ ] **Step 4: Run full Ludora task verification**

Run from `ludora-admin-service`: `npm test`

Run from `ludora-admin-service`: `npm run build`

Run from `ludora-discovery`: `python -m unittest discover -s tests -v`

Expected: all admin-service tests pass, build exits 0, and all discovery tests pass.

- [ ] **Step 5: Commit the regression coverage**

```powershell
git add ludora-admin-service/src/itemMatching/itemMatchingService.ts ludora-admin-service/src/itemMatching/itemMatchingService.test.ts ludora-admin-service/src/aiBggMatching/aiBggMatchingService.test.ts ludora-discovery/tests/test_admin_matching.py
git commit -m "test: preserve AI BGG matching outcomes"
```

### Task 8: Document production isolation and run cross-repository security verification

**Files:**
- Modify in Ludora: `docs/production-deployment.md`
- Review in CodexAPI: all files changed by Tasks 1-4
- Review in Ludora: all files changed by Tasks 5-7

**Interfaces:**
- Produces documentation only; does not create the user, move authentication, restart services, or deploy.
- Runbook must contain provisioning, authentication verification, migration, rollback, loopback verification, and a canary-denial proof.

- [ ] **Step 1: Update the production runbook**

Document a future operator sequence that creates system user/group `codexapi`, `/var/lib/codexapi` and `/var/lib/codexapi/workspace` at mode `0700`, establishes a dedicated `HOME`/`CODEX_HOME`, verifies `codex login status` as that identity, and updates only `codexapi.service`. Include the approved systemd settings: `NoNewPrivileges=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, `ProtectClock=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `UMask=0077`, restricted address families, and `ReadWritePaths=/var/lib/codexapi`. Keep binding `127.0.0.1:3001` with no nginx/firewall exposure.

Include rollback to the prior unit file/service identity and these read-only verification outcomes: effective unit user is `codexapi`; `/health` reports constrained policy; CodexAPI identity cannot read a root-owned canary under `/opt/ludora/ludora-admin`; Ludora admin service can reach loopback CodexAPI; no external socket listens on 3001. Mark every command as future deployment procedure, not executed evidence.

- [ ] **Step 2: Run static security scans**

In CodexAPI, run:

```powershell
rg -n "danger-full-access|dangerously-bypass|app-server|CODEX_DISABLE_|CODEX_PROFILE" src test README.md .env.example AGENTS.md
```

Expected: no executable/config path can enable those behaviors; any remaining prose is an explicit prohibition or migration note.

Run:

```powershell
rg -n "shell_tool|web_search|--image|read-only|approval_policy" src test
```

Expected: fixed disabling/defaults and explicit request opt-in are covered by tests.

- [ ] **Step 3: Run final CodexAPI verification in the isolated worktree**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `git diff --check HEAD~4..HEAD`

Expected: all tests pass, both TypeScript commands exit 0, and diff check emits no errors.

- [ ] **Step 4: Run a local CLI security probe without using port 3001**

Invoke the assembled runner directly from a temporary script/test harness with a malicious prompt that asks to read a known canary file and with web search disabled. Assert the JSONL contains no command-execution/tool event and no canary content. Then invoke a BGG name probe with `webSearch:true` and shell disabled; assert it can identify the known Coffee Rush BGG record (ID 377061). Use only a public, non-sensitive test cover for the attachment probe and remove the temporary directory in `finally`.

- [ ] **Step 5: Run final Ludora verification**

From `ludora-admin-service`, run `npm test` and `npm run build`.

From `ludora-discovery`, run `python -m unittest discover -s tests -v`.

Run `git diff --check` and confirm no database patch/schema files changed.

Expected: all suites/builds pass, diff check is clean, and `git diff --name-only` contains no `database/patches` or `database/schema.sql` entry.

- [ ] **Step 6: Commit the runbook**

```powershell
git add docs/production-deployment.md
git commit -m "docs: isolate CodexAPI production identity"
```

- [ ] **Step 7: Perform two-stage final review**

First review spec compliance against `docs/superpowers/specs/2026-08-10-capability-constrained-api-design.md`, then review code quality/security with emphasis on command arguments, SSRF/DNS rebinding, cleanup, unsupported tool rejection, cache context, transaction rollback/concurrency, and malformed negative decisions. Resolve every merge-blocking finding with a failing regression test and a focused fix commit, then rerun the complete verification commands from Steps 3 and 5.

## Self-Review Record

- Spec coverage: Tasks 1-4 implement the fixed CodexAPI boundary, explicit tool contract, safe image fetch, version gate, and local documentation. Tasks 5-7 implement every listed Ludora correctness fix. Task 8 covers the unexecuted production-isolation runbook and both repositories' final verification.
- Placeholder scan: the plan contains no deferred implementation markers or unspecified error-handling steps. The Python legacy base-URL assertion is conditional only on the existing classifier boundary because the approved design lists it as a non-blocking follow-up; it cannot block the security work if the path is untouched.
- Type consistency: `CodexRunOptions.webSearch/imagePaths`, `NormalizedResponsesRequest`, and `PreparedRemoteImage` flow from parser to server to runner. Cache lookup/write both consume the identical `{ imageUrl: string | null }` context.
- Scope boundary: no live server restart, production mutation, deployment, database patch, DDL, or DML is included.
