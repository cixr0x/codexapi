# Capable, Isolated CodexAPI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore one-request public-web and visual BGG matching while preventing shell execution, writes outside a request workspace, and access to Ludora secrets or internal services.

**Architecture:** Ludora sends only the normal `itemName`/`imageUrl` text data. CodexAPI runs the pinned Codex CLI with default live web search, browser/image capabilities, an empty integration inventory, a fixed permission profile, and one temporary workspace per invocation. Security is enforced by the Codex permission profile plus the existing dedicated systemd identity; the JSONL parser validates output correctness instead of disabling every research tool.

**Tech Stack:** TypeScript, Node.js 22+, Fastify, Vitest, OpenAI-compatible Responses SDK, Codex CLI `0.147.0`, systemd, PowerShell/Pester production-runbook tests.

## Global Constraints

- Keep CodexAPI fixed at `127.0.0.1:3001`; never expose it through nginx or a public firewall rule.
- Keep `@openai/codex` pinned exactly to `0.147.0`.
- Keep `approval_policy="never"`, strict config, ignored operator/project configuration, ephemeral Codex sessions, and `mcp_servers={}`.
- Live web search is available on every request, including requests without a `tools` declaration.
- Disable `shell_tool`, `shell_snapshot`, and `unified_exec`; do not add a shell fallback.
- The BGG matcher sends one text content part containing only `itemName` and optional `imageUrl`; it sends no `input_image` part and no explicit web-search declaration.
- Preserve generic CodexAPI `input_image` compatibility for other callers.
- Permit writes only inside a newly created request directory beneath `CODEX_WORKSPACE`.
- Deny model-controlled reads of Ludora checkouts, `.env` data, operator homes, and `CODEX_HOME`.
- Deny model-controlled access to loopback, private, link-local, metadata, and Unix-socket services while allowing public HTTPS research.
- Preserve structured-output validation, bounded output, cancellation, TERM-to-KILL handling, and cleanup-after-close behavior.
- Do not add or execute SQL, database patches, DDL, or DML.
- Preserve the two existing untracked local CodexAPI server log files.

---

## File Structure

### CodexAPI repository: `C:\PROJECTS\codexapi`

- Create `deploy/codexapi-runtime.config.toml`: checked-in Codex permission profile used by local and production execution.
- Create `src/requestWorkspace.ts`: request-directory creation, containment validation, and cleanup.
- Create `test/requestWorkspace.test.ts`: request workspace lifecycle tests.
- Create `test/runtimeProfile.test.ts`: static policy and pinned-CLI profile parsing tests.
- Modify `src/executionPolicy.ts`: short prohibited-feature list, required research features, profile name, and health projection.
- Modify `src/codexRunner.ts`: request workspace lifecycle, fixed profile, default live search, required feature args, and research-event decoding.
- Modify `src/codexCapabilityCheck.ts`: attest required/prohibited features and empty MCP inventory without rejecting unrelated enabled features.
- Modify `src/openaiCompat.ts`: validate legacy web-search declarations without using them as an opt-in switch.
- Modify `src/server.ts`: remove request-level web-search toggling and report search as always available.
- Modify `deploy/codexapi.service`: install the checked-in runtime profile before startup and preserve the dedicated service boundary.
- Modify `README.md`: document the capable-isolated contract and default web search.
- Modify focused tests under `test/` for the changed runtime contract.

### Ludora admin repository: `C:\PROJECTS\ludora\ludora-admin`

- Modify `ludora-admin-service/src/aiBggMatching/aiBggMatchingPrompts.ts`: tell Codex to open the prompt URL and visually compare public covers.
- Modify `ludora-admin-service/src/aiBggMatching/codexAiBggMatchingClient.ts`: send text only and rely on default web search.
- Modify `ludora-admin-service/src/aiBggMatching/aiBggMatchingService.test.ts`: regress the text-only request.
- Create `ludora-admin-service/src/aiBggMatching/aiBggMatchingCanary.ts`: reusable, database-free exact-match canary.
- Create `ludora-admin-service/src/aiBggMatching/aiBggMatchingCanary.test.ts`: unit-test the canary contract.
- Create `ludora-admin-service/src/scripts/verifyAiBggMatching.ts`: invoke the canary against loopback CodexAPI.
- Modify `ludora-admin-service/package.json`: add `verify:ai-bgg`.
- Modify `docs/ai-api-flow.md`: document text-only autonomous cover research.
- Modify `docs/production-deployment.md`: install/verify the runtime profile and run the exact BGG canary.
- Modify `ops/tests/ProductionDeploymentRunbook.Tests.ps1`: assert the revised fail-closed deployment sequence.

---

### Task 1: Make the Ludora matcher request text-only

**Files:**
- Modify: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\aiBggMatching\aiBggMatchingPrompts.ts`
- Modify: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\aiBggMatching\codexAiBggMatchingClient.ts`
- Modify: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\aiBggMatching\aiBggMatchingService.test.ts`
- Modify: `C:\PROJECTS\ludora\ludora-admin\docs\ai-api-flow.md`

**Interfaces:**
- Consumes: `AiBggMatchRequest { itemName: string; imageUrl: string | null }` and `createCodexResponsesClient()`.
- Produces: one Responses request with `input[0].content` containing exactly one `input_text` part and the existing strict `ai_bgg_match_decision` schema.

- [ ] **Step 1: Change the client expectation first**

Replace the positive-client assertion with an exact text-only request assertion:

```ts
expect(responsesCreate).toHaveBeenCalledWith(expect.objectContaining({
  model: 'gpt-5.6-terra',
  input: [{
    role: 'user',
    content: [{
      type: 'input_text',
      text: JSON.stringify({
        itemName: 'Catan',
        imageUrl: 'https://store.mx/catan.jpg'
      })
    }]
  }],
  text: expect.objectContaining({
    format: expect.objectContaining({
      name: 'ai_bgg_match_decision',
      strict: true,
      type: 'json_schema'
    })
  })
}));

const sent = responsesCreate.mock.calls[0]?.[0];
expect(sent).not.toHaveProperty('tools');
expect(JSON.stringify(sent)).not.toContain('input_image');
```

Add a prompt assertion:

```ts
expect(systemPromptForAiBggMatch()).toContain(
  'open the public imageUrl using your web and image tools'
);
expect(systemPromptForAiBggMatch()).toContain(
  'do not expect the store cover to be attached'
);
```

- [ ] **Step 2: Run the focused test and capture RED**

Run from `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service`:

```powershell
npm test -- src/aiBggMatching/aiBggMatchingService.test.ts
```

Expected: FAIL because the client still sends `tools` and `input_image`, and the fixed prompt lacks the autonomous URL instructions.

- [ ] **Step 3: Implement the minimal client and prompt change**

Remove the `OpenAI` import and the mutable content construction. Build the request as:

```ts
const response = await responses.create({
  model: context.model,
  instructions: systemPromptForAiBggMatch(),
  input: [{
    role: 'user',
    content: [{ type: 'input_text', text: userPromptForAiBggMatch(request) }]
  }],
  text: {
    format: {
      type: 'json_schema',
      name: 'ai_bgg_match_decision',
      strict: true,
      schema: aiBggMatchSchema
    }
  }
});
```

Add fixed prompt language that says:

```text
When imageUrl is non-empty, open the public imageUrl using your web and image tools and inspect the actual store cover. Do not expect the store cover to be attached. Search BGG, open the candidate BGG page and cover, and visually compare both covers before deciding. When imageUrl is empty or unavailable, continue with name-only research.
```

- [ ] **Step 4: Update the AI flow documentation**

In `docs/ai-api-flow.md`, state that the matcher sends only JSON text data, Codex opens public cover URLs during the same invocation, and generic `input_image` transport is not used by this feature.

- [ ] **Step 5: Run focused verification**

```powershell
npm test -- src/aiBggMatching/aiBggMatchingService.test.ts
npm run build
```

Expected: focused tests pass and TypeScript build exits `0`.

- [ ] **Step 6: Commit the Ludora client slice**

Run from `C:\PROJECTS\ludora\ludora-admin`:

```powershell
git add -- ludora-admin-service/src/aiBggMatching/aiBggMatchingPrompts.ts ludora-admin-service/src/aiBggMatching/codexAiBggMatchingClient.ts ludora-admin-service/src/aiBggMatching/aiBggMatchingService.test.ts docs/ai-api-flow.md
git commit -m "fix: let Codex research BGG covers"
```

---

### Task 2: Define the capable runtime policy and permission profile

**Files:**
- Create: `C:\PROJECTS\codexapi\deploy\codexapi-runtime.config.toml`
- Create: `C:\PROJECTS\codexapi\test\runtimeProfile.test.ts`
- Modify: `C:\PROJECTS\codexapi\src\executionPolicy.ts`
- Modify: `C:\PROJECTS\codexapi\test\executionPolicy.test.ts`

**Interfaces:**
- Produces: `CODEX_EXECUTION_POLICY.permissionProfile`, `defaultWebSearch`, `disabledFeatures`, and `requiredFeatures` consumed by the runner and startup attestation.
- Produces: profile name `codexapi-runtime` and policy name `codexapi-capable-isolated-v2`.

- [ ] **Step 1: Write failing policy tests**

```ts
expect(CODEX_EXECUTION_POLICY.permissionProfile).toBe('codexapi-runtime');
expect(CODEX_EXECUTION_POLICY.defaultWebSearch).toBe(true);
expect(CODEX_EXECUTION_POLICY.disabledFeatures).toEqual([
  'shell_tool',
  'shell_snapshot',
  'unified_exec'
]);
expect(CODEX_EXECUTION_POLICY.requiredFeatures).toEqual([
  { name: 'browser_use', maturity: 'stable' },
  { name: 'browser_use_external', maturity: 'stable' },
  { name: 'code_mode', maturity: 'under development' },
  { name: 'code_mode_host', maturity: 'stable' },
  { name: 'in_app_browser', maturity: 'stable' },
  { name: 'view_image', maturity: 'stable' }
]);
```

Assert that `executionPolicyHealth()` returns detached arrays and no longer exposes `allowedEnabledFeatures`.

- [ ] **Step 2: Write the profile contract test**

Create `test/runtimeProfile.test.ts` and assert that the checked-in profile contains:

```ts
expect(profile).toContain('default_permissions = "codexapi-runtime"');
expect(profile).toContain('web_search = "live"');
expect(profile).toContain('view_image = true');
expect(profile).toContain('"/opt/ludora/ludora-admin" = "deny"');
expect(profile).toContain('"/var/lib/codexapi/home" = "deny"');
expect(profile).toContain('"." = "write"');
expect(profile).toContain('allow_local_binding = false');
expect(profile).toContain('"metadata.google.internal" = "deny"');
```

Also reject `danger-full-access`, `network.mode = "full"`, and any filesystem write rule outside `:workspace_roots`.

- [ ] **Step 3: Run the focused tests and capture RED**

```powershell
npm test -- test/executionPolicy.test.ts test/runtimeProfile.test.ts
```

Expected: FAIL because the short policy fields and profile file do not exist.

- [ ] **Step 4: Add the fixed runtime profile**

Create `deploy/codexapi-runtime.config.toml` with this policy:

```toml
default_permissions = "codexapi-runtime"
web_search = "live"

[tools]
web_search = true
view_image = true

[permissions.codexapi-runtime]
description = "Public-web research with request-workspace-only writes."

[permissions.codexapi-runtime.filesystem]
":minimal" = "read"
"/opt/ludora/ludora-admin" = "deny"
"/opt/ludora/codexapi" = "deny"
"/home" = "deny"
"/root" = "deny"
"/var/lib/codexapi/home" = "deny"

[permissions.codexapi-runtime.filesystem.":workspace_roots"]
"." = "write"
"**/.env" = "deny"
"**/.env.*" = "deny"

[permissions.codexapi-runtime.network]
enabled = true
mode = "limited"
allow_local_binding = false
allow_upstream_proxy = false
dangerously_allow_all_unix_sockets = false
dangerously_allow_non_loopback_proxy = false

[permissions.codexapi-runtime.network.domains]
"*" = "allow"
"localhost" = "deny"
"**.localhost" = "deny"
"127.0.0.1" = "deny"
"::1" = "deny"
"169.254.169.254" = "deny"
"metadata.google.internal" = "deny"
```

- [ ] **Step 5: Replace the exhaustive application policy**

Use immutable constants shaped as:

```ts
export const CODEX_EXECUTION_POLICY = Object.freeze({
  backend: 'exec' as const,
  permissionProfile: 'codexapi-runtime' as const,
  approvalPolicy: 'never' as const,
  mcpServers: 'empty' as const,
  defaultWebSearch: true as const,
  disabledFeatures: Object.freeze([
    'shell_tool',
    'shell_snapshot',
    'unified_exec'
  ]),
  requiredFeatures: Object.freeze([
    Object.freeze({ name: 'browser_use', maturity: 'stable' as const }),
    Object.freeze({ name: 'browser_use_external', maturity: 'stable' as const }),
    Object.freeze({ name: 'code_mode', maturity: 'under development' as const }),
    Object.freeze({ name: 'code_mode_host', maturity: 'stable' as const }),
    Object.freeze({ name: 'in_app_browser', maturity: 'stable' as const }),
    Object.freeze({ name: 'view_image', maturity: 'stable' as const })
  ]),
  ignoreUserConfig: true,
  ignoreRules: true,
  ephemeral: true,
  strictConfig: true
});
```

Keep the existing workspace/home path validation. Remove the `allowedEnabledFeatures` contract and update the health projection.
Delete the unused `CodexRequestCapabilities` interface; request-level web-search capability is no longer part of the policy model.

- [ ] **Step 6: Run focused verification**

```powershell
npm test -- test/executionPolicy.test.ts test/runtimeProfile.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 7: Commit the policy definition**

```powershell
git add -- deploy/codexapi-runtime.config.toml src/executionPolicy.ts test/executionPolicy.test.ts test/runtimeProfile.test.ts
git commit -m "security: define capable Codex runtime profile"
```

---

### Task 3: Create one temporary workspace per Codex invocation

**Files:**
- Create: `C:\PROJECTS\codexapi\src\requestWorkspace.ts`
- Create: `C:\PROJECTS\codexapi\test\requestWorkspace.test.ts`
- Modify: `C:\PROJECTS\codexapi\src\codexRunner.ts`
- Modify: `C:\PROJECTS\codexapi\test\codexRunner.test.ts`

**Interfaces:**
- Produces: `createRequestWorkspace(basePath): Promise<RequestWorkspace>`.
- Produces: `RequestWorkspace { path: string; cleanup(): Promise<void> }` and `RequestWorkspaceFactory` for runner test injection.
- Consumes: the already validated `CodexRunnerConfig.workspace` base directory.

- [ ] **Step 1: Write request-workspace lifecycle tests**

Cover these exact behaviors:

```ts
const first = await createRequestWorkspace(base);
const second = await createRequestWorkspace(base);
expect(first.path).not.toBe(second.path);
expect(relative(base, first.path)).not.toMatch(/^\.\./u);
await first.cleanup();
await expect(stat(first.path)).rejects.toMatchObject({ code: 'ENOENT' });
await second.cleanup();
```

Also assert a missing, non-directory, or symlinked base is rejected before child creation, and repeated cleanup is safe.

- [ ] **Step 2: Add runner RED tests**

Update the runner argument test to require:

```ts
expect(spawnedArgs).toContain('--profile');
expect(spawnedArgs).toContain('codexapi-runtime');
expect(spawnedArgs).toContain('--enable');
expect(spawnedArgs).toContain('code_mode_host');
expect(spawnedArgs).toContain('--disable');
expect(spawnedArgs).toContain('shell_tool');
expect(spawnedArgs).not.toContain('--sandbox');
expect(spawnedArgs).toContain('web_search="live"');
expect(spawnedArgs).toContain('tools.web_search=true');
expect(spawnOptions.cwd).toBe(requestWorkspace.path);
```

Assert the request directory is removed after success, nonzero exit, spawn failure, timeout, cancellation, structured-output failure, and verified child close. Assert it is retained until `cleanupWhenSafe` resolves when termination cannot yet be verified.

- [ ] **Step 3: Run the focused tests and capture RED**

```powershell
npm test -- test/requestWorkspace.test.ts test/codexRunner.test.ts
```

Expected: workspace module is missing and the runner still uses the shared read-only workspace and exhaustive disable args.

- [ ] **Step 4: Implement the focused workspace module**

Use this public shape:

```ts
export interface RequestWorkspace {
  readonly path: string;
  cleanup(): Promise<void>;
}

export type RequestWorkspaceFactory = (
  basePath: string
) => Promise<RequestWorkspace>;

export async function createRequestWorkspace(
  basePath: string
): Promise<RequestWorkspace> {
  // Resolve and attest the existing non-symlink base, create a random child
  // with mkdtemp, re-attest containment, and return idempotent recursive cleanup.
}
```

Use `realpath`, `lstat`, `mkdtemp`, `relative`, and `rm`. Never construct a cleanup target from prompt data.

- [ ] **Step 5: Move schema files and child cwd into the request directory**

Add `requestWorkspaceFactory?: RequestWorkspaceFactory` to `CodexRunnerConfig`. Create the request workspace before writing the output schema or spawning. Write the schema to `join(requestWorkspace.path, '.codexapi-output-schema.json')` and pass the request path as both spawn `cwd` and Codex `-C` value.

Keep cleanup outside the child lifecycle. If `CodexRunnerError.childMayBeRunning` is true, attach request cleanup to `cleanupWhenSafe`; otherwise await cleanup in `finally`.

- [ ] **Step 6: Replace the runner argument policy**

Build the fixed arguments as:

```ts
const args = [
  ...commandArgs,
  'exec',
  '-',
  '--json',
  '--skip-git-repo-check',
  '--profile',
  CODEX_EXECUTION_POLICY.permissionProfile,
  '-C',
  requestWorkspace.path,
  '-c',
  `approval_policy=${tomlString(CODEX_EXECUTION_POLICY.approvalPolicy)}`,
  '-c',
  'mcp_servers={}',
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  '--strict-config',
  ...CODEX_EXECUTION_POLICY.requiredFeatures.flatMap(({ name }) => ['--enable', name]),
  ...CODEX_EXECUTION_POLICY.disabledFeatures.flatMap((name) => ['--disable', name]),
  '-c',
  'web_search="live"',
  '-c',
  'tools.web_search=true',
  ...imagePaths.flatMap((path) => ['--image', path])
];
```

Keep `CodexRunOptions.webSearch` temporarily for source compatibility in this task, but ignore its value and always enable search. Task 5 removes the obsolete field after the server and normalizer are migrated together. Preserve generic `imagePaths`.

- [ ] **Step 7: Run focused verification**

```powershell
npm test -- test/requestWorkspace.test.ts test/codexRunner.test.ts
npm run typecheck
```

Expected: all workspace, runner, cancellation, schema, and cleanup tests pass.

- [ ] **Step 8: Commit the runner slice**

```powershell
git add -- src/requestWorkspace.ts src/codexRunner.ts test/requestWorkspace.test.ts test/codexRunner.test.ts
git commit -m "feat: run Codex in isolated request workspaces"
```

---

### Task 4: Attest only required and prohibited capabilities

**Files:**
- Modify: `C:\PROJECTS\codexapi\src\codexCapabilityCheck.ts`
- Modify: `C:\PROJECTS\codexapi\test\codexCapabilityCheck.test.ts`
- Modify: `C:\PROJECTS\codexapi\test\codexCliIsolation.test.ts`
- Modify: `C:\PROJECTS\codexapi\test\server.test.ts`

**Interfaces:**
- Consumes: `CODEX_EXECUTION_POLICY.requiredFeatures`, `disabledFeatures`, and `permissionProfile`.
- Produces: `CodexCapabilityReport { version, requiredFeatures, disabledFeatures, permissionProfile, webSearch, checked }`.

- [ ] **Step 1: Replace the exhaustive feature-table test fixtures**

Build a pinned feature fixture that contains the three prohibited rows as false, the six required rows as true with exact maturity, and unrelated enabled rows such as `apps stable true` and `multi_agent stable true`.

Assert:

```ts
await expect(assertCodexCapabilities(config, spawn)).resolves.toEqual({
  version: '0.147.0',
  requiredFeatures: [
    'browser_use',
    'browser_use_external',
    'code_mode',
    'code_mode_host',
    'in_app_browser',
    'view_image'
  ],
  disabledFeatures: ['shell_tool', 'shell_snapshot', 'unified_exec'],
  permissionProfile: 'codexapi-runtime',
  webSearch: 'live',
  checked: true
});
```

Add one RED case for each missing, false, or maturity-drifted required feature; one for each enabled prohibited feature; and a GREEN case proving unrelated enabled rows are accepted.

- [ ] **Step 2: Run the capability tests and capture RED**

```powershell
npm test -- test/codexCapabilityCheck.test.ts test/codexCliIsolation.test.ts test/server.test.ts
```

Expected: FAIL because startup still requires every other feature to be false and reports policy `codexapi-constrained-v1`.

- [ ] **Step 3: Implement the new feature parser contract**

Parse every nonblank feature row into:

```ts
interface CodexFeatureState {
  maturity: string;
  enabled: boolean;
}
```

Reject malformed and duplicate rows. For each prohibited feature, require `enabled === false`. For each required feature, require the exact configured maturity and `enabled === true`. Do not reject other enabled feature rows.

Set:

```ts
export const CODEX_CAPABILITY_POLICY_NAME = 'codexapi-capable-isolated-v2';
```

Use the same `--profile`, `--enable`, `--disable`, live-search, strict-config, ignored-config, and empty-MCP arguments as the runner.

- [ ] **Step 4: Update the offline pinned-CLI integration test**

Copy `deploy/codexapi-runtime.config.toml` into the disposable test `CODEX_HOME` as `codexapi-runtime.config.toml`, then execute only non-inference probes:

```text
codex --version
codex --profile codexapi-runtime [feature switches] features list
codex --profile codexapi-runtime -c mcp_servers={} mcp list --json
```

Assert exact version `0.147.0`, required/prohibited feature states, and `[]` MCP inventory.

- [ ] **Step 5: Update startup and health assertions**

Require the new capability report and policy name in `test/server.test.ts`. Keep startup-before-listen ordering, probe timeouts, byte bounds, TERM/KILL, and close verification unchanged.

- [ ] **Step 6: Run focused verification**

```powershell
npm test -- test/codexCapabilityCheck.test.ts test/codexCliIsolation.test.ts test/server.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit startup attestation**

```powershell
git add -- src/codexCapabilityCheck.ts test/codexCapabilityCheck.test.ts test/codexCliIsolation.test.ts test/server.test.ts
git commit -m "fix: attest capable Codex runtime"
```

---

### Task 5: Make web search default and accept research event lifecycles

**Files:**
- Modify: `C:\PROJECTS\codexapi\src\codexRunner.ts`
- Modify: `C:\PROJECTS\codexapi\src\openaiCompat.ts`
- Modify: `C:\PROJECTS\codexapi\src\server.ts`
- Modify: `C:\PROJECTS\codexapi\test\codexRunner.test.ts`
- Modify: `C:\PROJECTS\codexapi\test\openaiCompat.test.ts`
- Modify: `C:\PROJECTS\codexapi\test\server.test.ts`

**Interfaces:**
- Produces: default live search for Chat Completions and Responses requests.
- Preserves: optional legacy Responses declaration `tools: [{ type: 'web_search' }]` as validated compatibility syntax.
- Produces: JSONL decoding that extracts only terminal agent text/usage while accepting non-command research items.

- [ ] **Step 1: Add default-search RED tests**

For a Responses request with no `tools`, and a Chat Completions request with no tools, assert that the runner is invoked without a request-level `webSearch` option and that the call log records `webSearchEnabled: true`.

Keep a compatibility test proving this request remains valid:

```json
{ "tools": [{ "type": "web_search" }] }
```

Keep malformed, duplicate, and unsupported tool declarations rejected.

- [ ] **Step 2: Add research-event RED tests**

Feed JSONL containing completion-only `image_view`, browser/research tool items, and ordinary metadata before `turn.completed`. Assert the final agent message and usage are returned.

Feed `command_execution` and assert `CodexRunnerError` code `INVALID_OUTPUT` with a bounded policy message. Keep duplicate terminal events, invalid message text, events after terminal completion, and raw-stdout fallback rejected.

- [ ] **Step 3: Run focused tests and capture RED**

```powershell
npm test -- test/codexRunner.test.ts test/openaiCompat.test.ts test/server.test.ts
```

Expected: no-tools requests disable search, and research item types are rejected.

- [ ] **Step 4: Make the API declaration validation-only**

Change `parseWebSearch()` into `validateWebSearchDeclaration(): void`. Remove `webSearch` from `NormalizedResponsesRequest`, `CodexRunOptions`, and the server option builders. Set `webSearchEnabled = true` in bounded call metadata because the capability is always offered.

Do not change generic `input_image` parsing, preparation, cleanup, or compatibility.

- [ ] **Step 5: Replace parser tool allowlisting with output-focused lifecycle checks**

Keep strict handling for `agent_message`, `reasoning`, and the pinned pre-turn diagnostic rules. For every other non-command item:

- require a nonempty unique item ID and nonempty item type;
- allow `item.started`, zero or more `item.updated`, and `item.completed`;
- allow completion-only tool items;
- reject updates after completion and duplicate completion;
- require started items to complete before `turn.completed`;
- reject `command_execution` explicitly;
- ignore tool payloads when constructing the public response.

Remove `webSearchAllowed` from `parseCodexOutput()`; web-search events are always permitted.

- [ ] **Step 6: Run focused verification**

```powershell
npm test -- test/codexRunner.test.ts test/openaiCompat.test.ts test/server.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit default search and event handling**

```powershell
git add -- src/codexRunner.ts src/openaiCompat.ts src/server.ts test/codexRunner.test.ts test/openaiCompat.test.ts test/server.test.ts
git commit -m "feat: enable Codex public research by default"
```

---

### Task 6: Package the production boundary and update CodexAPI documentation

**Files:**
- Modify: `C:\PROJECTS\codexapi\deploy\codexapi.service`
- Modify: `C:\PROJECTS\codexapi\test\systemdUnit.test.ts`
- Modify: `C:\PROJECTS\codexapi\README.md`

**Interfaces:**
- Consumes: checked-in `deploy/codexapi-runtime.config.toml`.
- Produces: installed `/var/lib/codexapi/home/codexapi-runtime.config.toml` before Node startup.

- [ ] **Step 1: Add the unit RED assertions**

Require one non-shell `ExecStartPre`:

```text
/usr/bin/install -m 0400 /opt/ludora/codexapi/deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml
```

Assert the unit still has the dedicated user/group, fixed environment, loopback listener configuration, `ProtectSystem=strict`, `ProtectHome=true`, empty capabilities, read-only checkout, `/var/lib/codexapi` as the only writable service path, and inaccessible `/opt/ludora/ludora-admin`, `/home`, and `/root` paths.

- [ ] **Step 2: Run the focused unit test and capture RED**

```powershell
npm test -- test/systemdUnit.test.ts
```

- [ ] **Step 3: Update the systemd unit**

Add the exact `ExecStartPre` above and change the inaccessible path line to:

```ini
InaccessiblePaths=/opt/ludora/ludora-admin /home /root
```

Do not add an `EnvironmentFile`, public bind, shell wrapper, ambient capability, or additional writable path.

- [ ] **Step 4: Rewrite the README capability section**

Document:

- policy name `codexapi-capable-isolated-v2`;
- live web search available by default;
- browser/image/code-host capability availability;
- shell and unified execution disabled;
- per-request workspace writes;
- empty inherited MCP inventory;
- generic explicit `input_image` compatibility remains supported;
- BGG matching may pass an image URL as ordinary prompt text;
- health output reports only required/prohibited features, not an exhaustive false table.

Update examples so one no-tools Responses request demonstrates default search. Keep one generic `input_image` example separate from BGG matching.

- [ ] **Step 5: Run focused and build verification**

```powershell
npm test -- test/systemdUnit.test.ts
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 6: Commit packaging and docs**

```powershell
git add -- deploy/codexapi.service test/systemdUnit.test.ts README.md
git commit -m "ops: package capable isolated CodexAPI"
```

---

### Task 7: Add a database-free BGG canary and update the production runbook

**Files:**
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\aiBggMatching\aiBggMatchingCanary.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\aiBggMatching\aiBggMatchingCanary.test.ts`
- Create: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\src\scripts\verifyAiBggMatching.ts`
- Modify: `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service\package.json`
- Modify: `C:\PROJECTS\ludora\ludora-admin\docs\production-deployment.md`
- Modify: `C:\PROJECTS\ludora\ludora-admin\ops\tests\ProductionDeploymentRunbook.Tests.ps1`

**Interfaces:**
- Produces: `verifyAiBggMatchingCanary(client, model): Promise<AiBggMatchDecision>`.
- Consumes: `AiBggMatchingClient.findMatch()` without database, cache, importer, or store-item writes.

- [ ] **Step 1: Write the canary unit tests**

```ts
it('verifies the exact Bomberos production regression without database access', async () => {
  const findMatch = vi.fn().mockResolvedValue({
    matchFound: true,
    bggId: 296354,
    matchedName: 'Rhino Hero: Firefighter',
    bggUrl: 'https://boardgamegeek.com/boardgame/296354',
    bggImageUrl: 'https://cf.geekdo-images.com/firefighter.jpg',
    nameAssessment: 'MATCH',
    coverAssessment: 'MATCH',
    confidence: 0.95,
    reasoning: 'Spanish HABA product and cover match.'
  });

  await expect(verifyAiBggMatchingCanary({ findMatch }, 'gpt-5.6-terra'))
    .resolves.toMatchObject({ bggId: 296354, matchFound: true });
  expect(findMatch).toHaveBeenCalledWith({
    itemName: 'Bomberos En Accion | Haba',
    imageUrl: 'https://cdn.shopify.com/s/files/1/0556/0493/6985/files/bomberos-en-accion-haba-152327.jpg?v=1726573771'
  }, { model: 'gpt-5.6-terra' });
});
```

Add a failure test for no match or any BGG ID other than `296354`.

- [ ] **Step 2: Run the canary test and capture RED**

```powershell
npm test -- src/aiBggMatching/aiBggMatchingCanary.test.ts
```

- [ ] **Step 3: Implement the canary and script**

The pure helper calls the client with the exact fixture above and throws:

```text
AI BGG canary expected BGG ID 296354.
```

The script loads the existing loopback CodexAPI base URL and shared model from admin config, creates `createCodexAiBggMatchingClient`, invokes the helper, and prints only:

```json
{"status":"ok","bggId":296354}
```

Add this package script:

```json
"verify:ai-bgg": "tsx src/scripts/verifyAiBggMatching.ts"
```

- [ ] **Step 4: Update the fail-closed runbook tests first**

Require the Routine Codex API Deployment section to:

1. stop CodexAPI before checkout/install/build;
2. install and `systemd-analyze verify` the checked-in unit;
3. start CodexAPI;
4. require health policy `codexapi-capable-isolated-v2` and exact CLI `0.147.0`;
5. require `systemctl show` to report the dedicated user and filesystem boundary;
6. keep the service stopped on any failed post-start check;
7. deploy admin-service only after CodexAPI verification;
8. run `npm run verify:ai-bgg` without database commands.

- [ ] **Step 5: Update the production runbook**

Update the existing routine Codex deployment and recovery blocks, rather than adding a second deployment mechanism. Add verification that `/var/lib/codexapi/home/codexapi-runtime.config.toml` matches the checked-in profile and is mode `0400`, then run the database-free canary after the admin-service revision is active.

- [ ] **Step 6: Run focused Ludora verification**

```powershell
npm test -- src/aiBggMatching/aiBggMatchingCanary.test.ts src/aiBggMatching/aiBggMatchingService.test.ts
npm run build
Invoke-Pester -Path ..\ops\tests\ProductionDeploymentRunbook.Tests.ps1
```

Expected: focused service tests, build, and Pester run pass. Do not run the live canary locally unless CodexAPI is intentionally running on fixed port `3001` with the approved runtime profile.

- [ ] **Step 7: Commit the canary and runbook**

Run from `C:\PROJECTS\ludora\ludora-admin`:

```powershell
git add -- ludora-admin-service/src/aiBggMatching/aiBggMatchingCanary.ts ludora-admin-service/src/aiBggMatching/aiBggMatchingCanary.test.ts ludora-admin-service/src/scripts/verifyAiBggMatching.ts ludora-admin-service/package.json docs/production-deployment.md ops/tests/ProductionDeploymentRunbook.Tests.ps1
git commit -m "test: add live AI BGG matching canary"
```

---

### Task 8: Run full gates, review, deploy, and verify exact revisions

**Files:**
- Review only: all files changed by Tasks 1-7.
- No database files may appear in either diff.

**Interfaces:**
- Consumes: committed CodexAPI and Ludora revisions from prior tasks.
- Produces: exact pushed SHAs and a verified production deployment, with rollback SHAs recorded before mutation.

- [ ] **Step 1: Run the complete CodexAPI gate**

From `C:\PROJECTS\codexapi`:

```powershell
npm test
npm run typecheck
npm run build
git diff --check origin/main...HEAD
git status --short
```

Expected: all tests pass; typecheck/build exit `0`; only the two pre-existing untracked server logs remain.

- [ ] **Step 2: Run the complete Ludora admin-service and deployment-doc gate**

From `C:\PROJECTS\ludora\ludora-admin\ludora-admin-service`:

```powershell
npm test
npm run build
Invoke-Pester -Path ..\ops\tests\ProductionDeploymentRunbook.Tests.ps1
git -C .. diff --check origin/main...HEAD
git -C .. status --short
```

Expected: full service tests/build and Pester pass, with a clean tracked worktree.

- [ ] **Step 3: Perform a focused security and behavior review**

Confirm from the exact diffs:

- no shell or unified-exec feature is enabled;
- no `danger-full-access` or public listener appears;
- no Ludora `input_image` matcher part remains;
- generic CodexAPI `input_image` tests remain green;
- web search is always live in runner args;
- permission profile is selected and installed;
- request workspace cleanup covers every child outcome;
- parser rejects command execution but accepts research/image events;
- no SQL, database patch, credential, or secret file is changed.

- [ ] **Step 4: Push exact reviewed revisions**

```powershell
$codexSha = git -C C:\PROJECTS\codexapi rev-parse HEAD
$ludoraSha = git -C C:\PROJECTS\ludora\ludora-admin rev-parse HEAD
git -C C:\PROJECTS\codexapi push origin main
git -C C:\PROJECTS\ludora\ludora-admin push origin main
git -C C:\PROJECTS\codexapi ls-remote origin refs/heads/main
git -C C:\PROJECTS\ludora\ludora-admin ls-remote origin refs/heads/main
```

Require each remote SHA to equal its local reviewed SHA.

- [ ] **Step 5: Deploy CodexAPI first using the revised routine runbook**

Use the approved full `$codexSha` in the `Routine Codex API Deployment` block in `docs/production-deployment.md`. Record the previous CodexAPI SHA. Keep the service stopped if checkout, install, tests, build, unit verification, capability attestation, health, or listener checks fail.

- [ ] **Step 6: Deploy the focused admin-service revision**

From `C:\PROJECTS\ludora\ludora-admin`:

```powershell
& .\ops\Deploy-LudoraAdmin.ps1 -ExpectedCommit $ludoraSha -Component Service
```

Do not pass `-RunTests` because full tests already ran locally and routine admin deployment omits remote test suites unless specifically requested.

- [ ] **Step 7: Run production read-only verification and the database-free canary**

On the admin VM, require:

```bash
set -euo pipefail
CODEXAPI_SHA="$(git -C /opt/ludora/codexapi rev-parse origin/main)"
LUDORA_SHA="$(git -C /opt/ludora/ludora-admin rev-parse origin/main)"
test "$(git -C /opt/ludora/codexapi rev-parse HEAD)" = "$CODEXAPI_SHA"
test "$(git -C /opt/ludora/ludora-admin rev-parse HEAD)" = "$LUDORA_SHA"
systemctl is-active --quiet codexapi.service
systemctl is-active --quiet ludora-admin-service.service
test "$(stat -c '%a' /var/lib/codexapi/home/codexapi-runtime.config.toml)" = "400"
cmp -s /opt/ludora/codexapi/deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml
test "$(systemctl show codexapi.service -p User --value)" = "codexapi"
test "$(systemctl show codexapi.service -p Group --value)" = "codexapi"
test "$(systemctl show codexapi.service -p ProtectSystem --value)" = "strict"
test "$(systemctl show codexapi.service -p ProtectHome --value)" = "yes"
systemctl show codexapi.service -p ReadWritePaths --value | grep -Fx -- '/var/lib/codexapi'
systemctl show codexapi.service -p InaccessiblePaths --value | grep -F -- '/opt/ludora/ludora-admin'
systemctl show codexapi.service -p InaccessiblePaths --value | grep -F -- '/home'
systemctl show codexapi.service -p InaccessiblePaths --value | grep -F -- '/root'
curl -fsS http://127.0.0.1:3001/health
test "$(ss -H -ltn 'sport = :3001' | wc -l)" -eq 1
ss -H -ltn 'sport = :3001' | grep -Eq '127[.]0[.]0[.]1:3001([[:space:]]|$)'
cd /opt/ludora/ludora-admin/ludora-admin-service
npm run verify:ai-bgg
```

The canary must print exactly `{"status":"ok","bggId":296354}` and performs no database access.

- [ ] **Step 8: Verify external isolation from the workstation**

```powershell
curl.exe -sS --connect-timeout 5 http://34.55.19.20:3001/health
```

Expected: connection fails. Also confirm the public admin HTTPS health/read-only checks from the existing deploy script remain green.

- [ ] **Step 9: Roll back both revisions if the canary fails**

Restore the previous admin-service revision through the existing admin rollback procedure, then restore the recorded previous CodexAPI commit through `CodexAPI previous-commit recovery`. Verify both exact SHAs, active services, loopback listeners, and public admin HTTPS. Do not execute SQL during rollback.
