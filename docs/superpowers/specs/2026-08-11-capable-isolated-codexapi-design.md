# Capable, Isolated CodexAPI Design

## Objective

Restore the Codex research and vision behavior required by Ludora's AI BGG matcher while keeping the Codex process unable to modify or inspect unrelated production resources.

The BGG matcher remains a single admin-service request. The normal text prompt contains `itemName` and optional `imageUrl`; the store image is not sent as an explicit `input_image` attachment. Codex must open the public store-image URL itself, search the public web, examine BGG candidates and their covers, and return a structured BGG match without a second admin-service orchestration step.

## Scope

This design changes the CodexAPI execution policy and its production isolation. It also removes the matcher's redundant `input_image` content part while preserving its `itemName` plus optional `imageUrl` text data. It does not add a BGG-specific endpoint to CodexAPI, add a second model call, or require database changes.

The existing matcher data contract remains `itemName` plus optional `imageUrl`. The URL is ordinary prompt data that Codex can follow with its public-web tools. The existing import, association, and match-cache behavior remains owned by Ludora after CodexAPI returns a candidate.

## Design decision

CodexAPI will use a capability-inside-isolation model:

- Codex research, browser, image-inspection, and code-mode capabilities are available.
- Live web search is available by default for every request; callers do not need to declare `tools: [{ "type": "web_search" }]`.
- The Codex process runs inside a fixed filesystem and network permission boundary.
- Shell and unified command execution remain disabled.
- Optional integrations are not globally feature-disabled, but none are inherited or configured implicitly.

This replaces the current policy of requiring nearly every Codex feature to report `false`. The pinned Codex version, isolated home, empty optional-integration inventory, fixed listener, and production service boundary continue to prevent configuration drift.

## Alternatives considered

### Selected: capable Codex inside a narrow runtime boundary

This most closely reproduces the working interactive Codex request while retaining practical production isolation. It uses Codex for the research loop and keeps Ludora unaware of intermediate BGG candidates.

### Rejected: two-stage matching in the admin service

The admin service could discover a candidate, retrieve its BGG cover, and submit a second verification request. This is deterministic but duplicates agent orchestration in Ludora and prevents Codex from completing the task autonomously in one request.

### Rejected: keep the exhaustive feature deny list

This is the current design. It disabled `code_mode_host`, which prevents reliable web search in the pinned CLI, and it rejects legitimate research and image events. Repeating that pattern would continue to trade away the capability the service exists to provide.

A separate container or VM per request is not justified for this loopback-only, single-platform service. It can be reconsidered if CodexAPI becomes public or multi-tenant.

## Request flow

1. Ludora sends one normal text prompt containing only `itemName` and optional `imageUrl`; it does not add an `input_image` part for the store cover.
2. CodexAPI passes that prompt to one Codex invocation without pre-downloading the prompt's image URL.
3. Codex receives live web search, browser/public-page access, image inspection, and code-mode reasoning capabilities.
4. During the same invocation, Codex opens the public store-image URL, searches BGG, follows candidate pages, opens candidate cover images, and visually compares the covers.
5. Codex returns the existing structured match result.
6. CodexAPI validates the terminal response and deletes all request-scoped temporary files created by its research tools.
7. Ludora applies its existing validation, import, association, and cache behavior.

There is one request from Ludora to CodexAPI and one Codex invocation. Intermediate searches, page visits, and image inspections are internal tool calls within that invocation.

## Codex capability policy

### Available

- Live web search, enabled for every request.
- `code_mode_host` and code-mode reasoning.
- Browser access to public web pages.
- Generic request image attachments for other CodexAPI callers. The BGG matcher does not use this path.
- Local image inspection through `view_image` for request-scoped or research-produced images.
- Normal reasoning and structured terminal output.

The implementation must use the smallest set of current Codex feature/configuration switches that supplies these behaviors, but it must not reinstate the exhaustive disabled-feature table.

### Prohibited

- Shell commands and unified process execution.
- Filesystem writes outside the request-scoped temporary workspace.
- Reads of Ludora source, environment files, deployment-user homes, administrator homes, CodexAPI source, or unrelated service state.
- Model-controlled access to loopback services, private networks, link-local addresses, cloud metadata endpoints, or Unix sockets.

Shell access may be reconsidered only through a separate approved design after a checked-in end-to-end test proves the matcher cannot perform the required public-web/image workflow without it. It is not part of this implementation.

### Optional capabilities

MCP, plugins, apps, and similar integrations are not inherited from any operator account. The dedicated Codex home starts with no configured external integrations. Future integrations must be installed deliberately and reviewed as separate production dependencies.

## Filesystem boundary

CodexAPI continues to run as the dedicated `codexapi` user under the checked-in systemd unit.

Each invocation receives a newly created request directory beneath the configured Codex workspace. The Codex permission profile grants that directory write access and grants only the minimum runtime paths needed to execute the pinned CLI. The directory is removed after success, failure, timeout, or cancellation.

The permission profile denies reads and writes to:

- `/opt/ludora/ludora-admin` and other Ludora checkouts;
- `/opt/ludora/codexapi`, except the runtime files required to start the already selected executable;
- `.env` and equivalent secret/configuration files;
- `/home`, `/root`, and deployment/operator homes;
- `/var/lib/codexapi/home` from model-controlled tools;
- other service state and system credential locations.

The parent Codex process may use its dedicated Codex authentication/configuration during startup. Model-controlled tools do not receive filesystem permission to inspect that location.

The systemd unit remains a second boundary with `ProtectSystem=strict`, `ProtectHome=true`, an empty capability set, explicit inaccessible Ludora/operator paths, and `/var/lib/codexapi` as its only writable service state.

## Network boundary

The HTTP server remains bound exactly to `127.0.0.1:3001` and is not exposed through nginx or a public firewall rule.

Model-controlled public-web tools may access public HTTPS destinations. The runtime network policy must reject, including after DNS resolution and every redirect:

- loopback addresses;
- RFC1918/private addresses;
- IPv6 unique-local addresses;
- link-local addresses;
- cloud metadata destinations;
- Unix sockets and local bind/listen operations.

The existing safe remote-image fetch rules remain in force for callers that explicitly use generic `input_image` content. URLs found in prompts or search results are handled by the public-web/browser boundary, which applies equivalent private-address, redirect, and size restrictions. Web search is always offered to the model; it is not interpreted as permission to reach internal services.

## Configuration and startup attestation

CodexAPI retains:

- the package-local pinned Codex executable and exact-version validation;
- strict configuration and ignored operator/project configuration;
- the dedicated absolute `CODEX_HOME` and workspace validation;
- the empty inherited MCP inventory;
- the fixed loopback host and port;
- startup failure when the required research/vision capability set is unavailable.

Startup attestation changes from "every non-removed feature must be false" to verifying only load-bearing invariants:

- prohibited command-execution capabilities are unavailable;
- required web-search, browser/image, and code-mode-host capabilities are available;
- no unapproved external integration is configured;
- the filesystem/network permission profile is selected;
- the pinned CLI is compatible with the expected event grammar.

## Event and output handling

The JSONL parser is an output decoder, not the primary security boundary.

It will:

- accept and record valid lifecycle events for reasoning, web search, browser/public-page access, image inspection, and agent messages;
- reject command-execution events because command execution is prohibited;
- reject malformed terminal output, missing completion, invalid structured output, and byte-limit violations;
- ignore documented nonterminal metadata events that do not affect the final result;
- never fall back to unstructured raw stdout as a successful response.

The public API continues to return only the final model response and usage information. Tool traces may be logged only through the existing bounded, nonsensitive logging path.

## Error behavior

- Failure to start with the required capability or isolation profile keeps CodexAPI unavailable.
- Unsafe explicit `input_image` URLs from generic API callers fail before Codex starts.
- A blocked or invalid image URL in ordinary prompt text remains model-visible as an unavailable public resource; Codex may continue name-only research or return no match.
- A timeout or client cancellation terminates the Codex process and removes request artifacts.
- A prohibited command attempt terminates the request as a policy error.
- Invalid or missing structured output is a processing error, never a guessed BGG ID.
- Web-search or browser failures remain model-visible during the turn so Codex can try another public source; if it cannot establish a match, it returns the existing no-match result.

## Verification

### Functional acceptance

- The production-equivalent request for `Bomberos En Accion | Haba` with its Shopify cover consistently returns BGG ID `296354`.
- The matcher request contains no `input_image` part; the Shopify URL appears only in the normal `itemName`/`imageUrl` prompt data.
- A Spanish product name can match an English BGG listing.
- Name-only matching still works when `imageUrl` is absent.
- Similar names with visibly conflicting covers produce no match.
- Web search works without a caller-supplied `tools` declaration.
- Requests that explicitly declare the existing web-search tool remain backward compatible.

### Capability acceptance

- The runner emits and accepts real web-search events.
- The runner can open the store image URL from ordinary prompt text and inspect a BGG cover discovered during the same invocation.
- No second Ludora-to-CodexAPI request is made.
- No shell or unified-exec event is possible.

### Isolation acceptance

Use disposable canaries to prove that a hostile prompt cannot:

- read Ludora source, `.env` files, Codex credentials, or operator-home files;
- write outside its request directory;
- connect to the admin service, database, metadata service, or another private/loopback endpoint;
- leave request artifacts after success, error, timeout, or cancellation.

Tests must not use real credentials, production data, database writes, or public service mutations.

## Rollout and rollback

Deploy CodexAPI through the existing checked-in unit and Ludora production runbook. Deploy the focused admin-service serialization change that removes the explicit store-cover `input_image` part. No SQL or database migration is required.

Before deployment, run the complete CodexAPI test, typecheck, build, capability canary, BGG matching canary, and isolation canary suites. After deployment, verify the fixed loopback listener, health policy, the `Bomberos En Accion` match, and the isolation canaries.

Rollback restores the previous CodexAPI commit and the previous focused admin-service serialization commit, then restarts their existing services. The public matcher data contract and database remain unchanged.
