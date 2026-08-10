# Capability-Constrained CodexAPI Design

## Goal

Make CodexAPI safe for automatically scraped and otherwise untrusted input while preserving every current text/structured-output caller and the AI BoardGameGeek matcher. CodexAPI becomes globally constrained: it has no privileged execution mode and cannot use shell, filesystem, apps, plugins, MCP, browser, computer-use, code execution, image generation, delegation, or other host-capable tools.

## Confirmed caller requirements

The existing Ludora translation, description generation, Amazon-title extraction, product-detail extraction, store-profile detection, and discovery-classification calls require only model reasoning and structured output over supplied text. The agent-player game decision flow also requires only structured output. The CodexAPI tester and agent-player chat accept arbitrary prompts, but neither application contract depends on host tools.

The AI BGG matcher is the only known application flow that needs a tool. It needs native public-web search plus visual access to the supplied store cover. It does not need a shell, local files, browser automation, apps, plugins, or private-network access.

## Threat model

Treat every API instruction, message, store title, description, raw payload, URL, web page, and image as attacker-controlled. The boundary must withstand a model following injected instructions; prompt wording is defense in depth, not the security control.

The constrained runner must prevent an API-launched model from:

- reading or modifying Ludora or CodexAPI source, `.env` files, JWKs, database credentials, Codex configuration, or unrelated host files;
- running commands or starting subprocesses;
- invoking apps, plugins, MCP servers, browser/computer-use, code execution, image generation, or subagents;
- reaching loopback, link-local, RFC 1918/private, cloud-metadata, Unix-socket, or other internal destinations;
- turning an image URL into an SSRF primitive;
- enabling a broader capability through request fields, environment variables, profiles, app-server mode, or user configuration.

## Global execution policy

CodexAPI will support only the `codex exec` backend. The app-server backend and external app-server URL will not be selectable because their persistent process/config surface is unnecessary for these inference calls.

Every run uses a fixed policy assembled by CodexAPI, not by the request:

- sandbox: `read-only`;
- approval policy: `never`, so denied actions fail instead of waiting for an unavailable operator;
- no `--dangerously-bypass-approvals-and-sandbox` flag;
- `shell_tool`, apps, plugins, shell snapshot, browser-use, computer-use, code-mode/code host, image generation, multi-agent, memories, hooks, and tool discovery disabled;
- user configuration and rules ignored;
- ephemeral sessions;
- a fixed empty workspace dedicated to inference, never a Ludora or CodexAPI checkout;
- local image viewing disabled; caller images are model attachments, not files the agent can browse;
- no environment option or HTTP request can switch to full access.

Startup and `/health` expose the effective policy. Startup fails closed when the configured backend, workspace, or policy is unsafe.

## Tool contract

Text and structured-output requests have no tools by default. `/v1/chat/completions` stays text-only.

`/v1/responses` accepts either no `tools` field or exactly one supported tool declaration:

```json
[{ "type": "web_search" }]
```

Any other tool, malformed declaration, duplicate, or non-auto tool choice receives an OpenAI-compatible `400 invalid_request_error` before Codex starts. When web search is absent, Codex runs with web search disabled. When present, Codex gets the native Responses web-search tool while shell/process networking remains unavailable.

The AI BGG caller opts in explicitly. Existing callers send no tools and remain text-only. Web search results remain untrusted, but they cannot cross the host boundary because all host-capable tools are absent.

## Safe cover-image attachment

The BGG matcher sends its dynamic data as the item name and nullable store image URL only. When an image URL is present, it is also represented as one `input_image` content item so CodexAPI can attach the actual cover to the model in the same request.

CodexAPI downloads at most one remote image through a dedicated safe fetcher:

- only `http` or `https`, with no URL credentials;
- only ports 80 and 443;
- resolve every hostname and reject the URL when any result is loopback, unspecified, link-local, private, reserved, multicast, or cloud metadata;
- validate every redirect target independently and allow no more than three redirects;
- no cookies, authorization, proxy credentials, or caller-controlled headers;
- connect/read timeout of 10 seconds;
- maximum response size of 8 MiB;
- accept only JPEG, PNG, or WebP after checking both content type and magic bytes;
- save to a per-request temporary directory, pass it to `codex exec --image`, and remove it in `finally` on success, error, cancellation, or timeout.

An absent, rejected, unreachable, oversized, or unsupported image is treated as unavailable rather than as a match failure. The model continues with the name and URL text and must apply the existing name-only matching rule. CodexAPI records only a bounded reason code, never image bytes or sensitive URL credentials.

The BGG cover is obtained through native web search. The store image is the only caller-supplied image attachment. A focused live probe must demonstrate that a known product can be found on BGG with shell disabled; a cover-comparison probe must prove the model receives the attached store image.

## Production isolation

Application-level capability removal is the primary control. Production adds defense in depth:

- run `codexapi.service` as a dedicated `codexapi` system user and group, not the Ludora deployment/service user;
- use `/var/lib/codexapi` as `HOME` and `CODEX_HOME`, with mode `0700` and no access granted to the Ludora service account;
- keep the checkout root-owned/read-only to the service;
- use `/var/lib/codexapi/workspace` as the empty inference workspace;
- make `/opt/ludora/ludora-admin` and `/home/robertorojas87` inaccessible to the unit;
- retain loopback-only HTTP binding and no nginx/firewall exposure;
- enable systemd hardening compatible with Node and the Codex Linux sandbox: `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectSystem=strict`, `ProtectHome`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`, `ProtectClock`, `RestrictSUIDSGID`, `LockPersonality`, `UMask=0077`, and restricted address families;
- grant writes only under `/var/lib/codexapi`.

The dedicated identity owns its own Codex authentication. The runbook will include provisioning, login-status verification, service migration, rollback, and proof that the CodexAPI identity cannot read a Ludora canary file. No production change is executed as part of local implementation unless the user separately requests deployment.

## Codex version boundary

The exact package-local `@openai/codex@0.147.0` security pin proves that disabling `shell_tool` and `view_image` removes those host actions while native web search and explicit `--image` attachments remain separate request capabilities. CodexAPI performs a startup exact-version and complete-feature-table check rather than assuming a CLI upgrade preserves flags. Every nonblank feature row must be unique and well formed; fixed-disabled rows must be false; only the explicitly recorded `removed` no-op rows may remain true at their pinned maturity. Unknown or incompatible capability output fails startup before the HTTP listener accepts inference traffic.

## Ludora integration and correctness fixes

The Ludora feature branch will consume the hardened contract and address the final-review findings in one consolidated wave:

- configure the shared OpenAI-compatible SDK with `maxRetries: 0`;
- add `tools: [{ type: "web_search" }]` only to the AI BGG request;
- attach the nullable store cover through `input_image` without adding language or any other dynamic field;
- include cover context in trusted AI cache identity so a same-title/different-cover item cannot reuse a trusted association;
- preserve name-only trusted matches as a distinct missing-image mode;
- make the complete AI cache write atomic on one database session, with rollback and deterministic query locking;
- reject inconsistent negative AI decisions such as `matchFound: false` with a non-null BGG ID;
- include matched name and name/cover assessments in traces;
- restore admin-confirmed no-match/error tests and assert the `image_url` database projection;
- retain the Python legacy loopback-base test and IPv6 normalization as non-blocking follow-ups unless touched by the fix.

No database schema or patch changes are required. No DDL or DML will be executed during implementation.

## Error behavior

- Unsupported tools or unsafe image request syntax: `400 invalid_request_error`, no Codex process.
- Safe image fetch rejection/failure: continue without the image and expose a bounded internal diagnostic for tracing.
- Codex startup policy/capability mismatch: service startup fails closed.
- Web search or model failure: preserve the existing OpenAI-compatible API error mapping.
- Ludora malformed AI decision or cache transaction failure: preserve `processing_error`; do not cache, import, or link a partial result.

## Verification

CodexAPI unit/integration coverage will verify:

- exact constrained command arguments and absence of every dangerous flag;
- shell and local-image tools disabled, read-only sandbox, approval never, and web search off by default;
- web-search opt-in mapping and rejection of every unsupported tool shape;
- app-server and unsafe configuration fail closed;
- SSRF blocks IPv4/IPv6 loopback, private/link-local/reserved ranges, metadata addresses, mixed DNS answers, and unsafe redirects;
- image size, MIME/magic-byte, timeout, redirect, cleanup, and no-header-forwarding behavior;
- a malicious prompt cannot produce a command-execution event while BGG web search still succeeds;
- health output describes the constrained policy.

Ludora coverage will verify the caller contract, cover-aware cache reuse, atomic rollback/concurrency behavior, one-call retry policy, negative-decision invariants, trace evidence, and preserved admin semantics. Final verification runs the full CodexAPI, admin-service, and discovery suites plus TypeScript builds and a whole-branch security review.

## Non-goals

- No privileged or trusted full-access API mode.
- No general browser or computer automation through CodexAPI.
- No deployment or production service-account mutation without a separate explicit deployment request.
- No database schema change.
