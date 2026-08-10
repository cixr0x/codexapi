# Task 3 Report: Safe caller image attachments

## Status

Complete. Work was confined to the isolated `capability-constrained-api` worktree. No service was started or stopped, port 3001 was untouched, all network behavior was exercised through injected fakes, and no database, deployment, production, or external write occurred.

## Implementation

### Destination validation and pinned transport

- Added `prepareRemoteImage(url, dependencies?)`, `PreparedRemoteImage`, and the closed 14-value `SafeImageReason` union in `src/safeRemoteImage.ts`.
- URL parsing rejects credentials, non-HTTP(S) schemes, empty hosts, and ports other than 80/443 before DNS or transport.
- Numeric IP hosts are classified directly; they cannot be made public by a lying resolver seam.
- DNS uses `lookup(hostname, { all: true, verbatim: true })`. Every answer must have a matching declared family and be public; one malformed or non-public answer rejects the entire destination.
- Separate IPv4 and IPv6 `net.BlockList` instances cover unspecified, loopback, link-local, private, shared, protocol-assignment, documentation, benchmarking, multicast, and reserved space. IPv6 is additionally fail-closed to IANA's currently allocated `2000::/3` global-unicast range, with explicit special-use exclusions including IPv4-mapped/translatable, NAT64, 6to4, documentation, discard-only, ULA, site-local, and multicast ranges. Registry references used during implementation:
  - https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.xhtml
  - https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
- Every redirect is resolved against the prior URL, re-parsed, re-resolved, and revalidated. Three redirects are allowed; a fourth is rejected.
- The native HTTP(S) transport preserves the original hostname for generated `Host` and TLS `servername`, but supplies a custom lookup callback containing only the selected prevalidated address. It uses no ambient proxy, caller headers, caller authorization, or caller cookies; the supplied header set is only `Host` and the minimal accepted-image MIME list.

### Verified temporary attachments

- Responses are accepted only for HTTP 2xx and exact JPEG, PNG, or WebP MIME types (parameters are tolerated).
- Declared and streamed sizes are bounded at `8 * 1024 * 1024` bytes. Streaming stops before an over-limit chunk is written.
- Downloads use a random `mkdtemp(join(tmpdir(), "codexapi-image-"))` directory and an exclusive `0600` staging file.
- The byte prefix must match JPEG `ffd8ff`, PNG `89504e470d0a1a0a`, or WebP `RIFF....WEBP`; the final extension is selected from verified bytes, not the URL.
- A close failure fails closed. Success and failure cleanup are idempotent, recursively target only the created directory, make three bounded deletion attempts, and retain a retryable cleanup when all initial attempts fail.
- The 10-second deadline and caller cancellation use injected timers/signals. Transport, DNS, filesystem, time, and temporary-root seams keep tests deterministic and socket-free.

### OpenAI compatibility and server integration

- Responses accepts at most one direct `input_image` part inside a message `content` array, only with a string `image_url`, and rejects `file_id`, malformed, duplicate, direct/top-level, and nested disguised image syntax before fetch or Codex invocation.
- Chat remains text-only and rejects both direct and nested `input_image` syntax before Codex invocation.
- The Responses prompt keeps the image URL as prompt data and renders the fixed marker `[store cover attached when available]`.
- The server passes a successfully verified local path through `CodexRunOptions.imagePaths`; fetch rejection continues name-only with `imagePaths: []` and a bounded diagnostic code.
- Cleanup runs from the Responses `finally` path after success, runner failure, structured-output failure, fetch cancellation, or Codex cancellation.
- JSONL logging remains allowlisted. The only new image field is the closed `imageDiagnosticCode`; raw URLs, credentials, DNS answers, bytes, temporary paths, commands, stdout, and stderr remain excluded.

### Request cancellation expansion

- Added `signal?: AbortSignal` to `CodexRunOptions` and a distinct bounded `CANCELLED` runner error.
- Responses propagates Fastify's framework-owned request-disconnect signal through image preparation and the Codex runner. A small injected signal-provider seam permits deterministic lifecycle tests without opening sockets.
- Already-aborted runs never spawn. Mid-run abort kills the child exactly once, stops stdin submission in the abort race, and settles only after child exit/close or a one-second bounded termination grace.
- Timeout keeps its existing `TIMEOUT` mapping while using the same close/grace cleanup safety.
- All timers, abort listeners, child listeners, and stream listeners are removed on settlement, including synchronous-close and duplicate-event races.
- The server maps cancellation to the fixed `499 request_cancelled` response and fixed message; runner stdout/stderr/command details cannot enter the API error or bounded log.
- Output-schema and image temporary directories remain present until the cancelled child exits/closes, avoiding Windows deletion races with open `--image`/`--output-schema` handles, then are removed.

## TDD evidence

### Baseline

```powershell
npm test -- --run test/openaiCompat.test.ts test/server.test.ts
```

Exit 0: 53 existing tests passed before Task 3 implementation.

### Initial contract RED

```powershell
npm test -- --run test/safeRemoteImage.test.ts test/openaiCompat.test.ts test/server.test.ts
```

Exit 1: `src/safeRemoteImage.ts` did not exist; seven normalization cases failed because no image was extracted or rejected, and five server cases failed because no image was prepared, attached, diagnosed, or cleaned. The 53 pre-existing compatibility/server tests remained green.

### Address-classification RED and diagnosis

The first fetcher implementation produced 17 focused failures: public IPv4 destinations were classified as non-public. A minimal `net.BlockList` reproduction showed that mixing IPv4 rules with the IPv6 `::ffff:0:0/96` mapped-address rule made public IPv4 checks match. Splitting the blocklists by family fixed the classifier without removing any SSRF exclusion.

```powershell
npm test -- --run test/safeRemoteImage.test.ts
```

Exit 0 after the fix: 56 tests passed at that checkpoint. Further RED cases then added numeric-host bypass prevention, IPv6 outside allocated global unicast, IPv4-translatable IPv6, close failure, cancellation cleanup, and retryable deletion.

### Malformed syntax review RED

Review tests demonstrated that a non-array Responses input object, a direct content object, and nested malformed chat content could contain `input_image` syntax while still reaching Codex. The iterative, cycle-safe syntax scanner and direct valid-shape parser now reject all such forms before fetch or runner invocation.

### Cancellation RED

```powershell
npm test -- --run test/codexRunner.test.ts
```

Exit 1 with four new failures before implementation: an already-aborted call spawned, mid-run and schema-backed aborts did not kill the child, and timeout settled before child closure. Subsequent RED cases proved an unbounded no-close wait and a synchronous-close grace-timer leak. The final state machine closes all five gaps while preserving timeout/error semantics.

The server request-disconnect RED timed out because the abort signal was initially passed only to the fetcher. Production now uses Fastify's `request.signal` and passes it to both fetch and runner. Deterministic server cases cover disconnect during fetch and after preparation/during Codex, fixed cancellation mapping, prompt cleanup, and sensitive-log exclusion.

### Cleanup RED

A failure-path test showed deletion was attempted once and then replaced with a no-op cleanup. A second RED showed a failed completed-file close was suppressed and returned a successful attachment. Cleanup now retries three times, remains retryable, and close errors fail closed with directory removal.

### Focused GREEN

```powershell
npm test -- --run test/safeRemoteImage.test.ts test/openaiCompat.test.ts test/server.test.ts test/codexRunner.test.ts
npm run typecheck
git diff --check
```

Exit 0: 4 files / 150 tests passed; TypeScript produced no diagnostics; the diff check was clean (only Git's configured LF-to-CRLF notices were printed).

### Final repository verification

```powershell
npm test
npm run build
```

Exit 0: all 9 test files / 211 tests passed, and the TypeScript build completed without diagnostics.

An independent final security review also re-ran the focused matrix (including the two logger tests: 5 files / 152 tests), typecheck, and diff check and returned a clean verdict with no remaining SSRF, lifecycle, normalization, logging, or cleanup finding.

## Files

- Created: `src/safeRemoteImage.ts`
- Modified: `src/openaiCompat.ts`, `src/server.ts`, `src/callLogger.ts`, `src/codexRunner.ts`
- Created: `test/safeRemoteImage.test.ts`
- Modified: `test/openaiCompat.test.ts`, `test/server.test.ts`, `test/codexRunner.test.ts`
- Created: `.superpowers/sdd/2026-08-10-capability-constrained-api/task-3-report.md`

## Self-review

- No test opens a socket or calls live DNS/HTTP; DNS answers, redirects, transport bodies, timers, request signals, and temporary roots are injected.
- URL fragments never enter the request path; caller headers and auth are never accepted by the transport interface.
- Mixed DNS answers reject all, every redirect revalidates, and the connection lookup is pinned while Host/SNI remain original.
- The byte limit is checked before writing the over-limit chunk; MIME and magic must agree; files are exclusive/private and extension selection is byte-derived.
- Every fetch failure returns a closed reason and `path: null`; production fetch failures never throw into the request and continue name-only unless the caller disconnected.
- Malformed/direct/nested/duplicate image syntax returns OpenAI-style HTTP 400 before fetch and runner calls.
- Cancellation kills once, has a bounded no-close fallback, cannot double-settle, removes all listeners/timers, and waits for process exit/close on the ordinary path before temporary cleanup.
- Bounded-log assertions seed raw URL credentials, metadata-style values, local temp paths, command flags, stdout, and stderr and prove none are persisted.

## Concern

No known functional or security blocker remains. As an unavoidable OS-level residual, a directory that remains undeletable after all three bounded removal attempts can persist; the cleanup object remains retryable and API behavior/logging stays bounded. Ordinary cancellation waits for process exit/close before deletion, which removes the Windows open-handle race that motivated this hardening.

## Fix Round 1

### Scope and outcome

This round addressed the two Important review findings without starting a service, touching port 3001, opening a network socket, using live DNS/HTTP, changing a database, deploying, or writing outside the isolated worktree.

1. Cancellation no longer launches Codex through the JavaScript shim and no longer settles ordinary cancellation/timeout merely because a grace period elapsed. The runner now targets the validated platform-native Codex process, escalates from `SIGTERM` to `SIGKILL`, and requires an observed `close` before ordinary resource cleanup; `exit` alone is not a cleanup boundary.
2. Responses and Chat now use a cycle-safe full-body occurrence scan. A Responses request is accepted only when the entire request contains exactly one `input_image` occurrence and that occurrence is the accepted direct message-content part. Chat rejects any occurrence anywhere in the body.

### Finding 1 RED: unverified process termination

The review reproduced the Windows launcher boundary:

```text
CodexAPI -> node.exe -> @openai/codex/bin/codex.js -> native codex.exe
```

Killing the Node launcher could leave the native process behind, while the old grace callback rejected with ordinary `CANCELLED` and allowed image/schema deletion without observing process termination.

New adversarial tests covered both signal-delivery failure modes:

- a graceful kill reports success but produces no lifecycle event, requiring a later `SIGKILL` and still remaining unsettled through `exit` until verified `close`;
- both `kill` calls return `false` and no lifecycle event arrives, requiring a bounded fatal result, retained schema, no ordinary cleanup, exactly two kill attempts, and listener/timer removal;
- the server receives the fatal state with a prepared image, returns only a fixed bounded error, retains the image lease, and persists neither URL nor path in its allowlisted log.

Before production changes:

```powershell
npm test -- --run test/codexRunner.test.ts test/server.test.ts
```

Exit 1: 3 tests failed and 59 passed. The runner used an unqualified default kill, settled the no-event case as `CANCELLED`, deleted the schema, and mapped the fatal server case through the generic CLI error path.

The native-command contract was separately driven RED:

```powershell
npm test -- --run test/config.test.ts
```

Exit 1: 1 test failed and 18 passed because `defaultCodexCommand()` returned absolute `node.exe` plus `bin/codex.js`, not the platform-native executable.

### Finding 1 GREEN: direct native process and truthful cleanup

- `defaultCodexCommand()` maps only the six supported platform/architecture pairs. It validates the exact base package name/version, the exact optional native dependency alias, the exact suffix-versioned platform package, and the canonical native executable's containment under that package. It returns the absolute native executable with no launcher arguments and has no `PATH`, `APPDATA`, wrapper, or caller-command fallback.
- The installed Windows x64 command resolves to the pinned `@openai/codex-win32-x64` package's `vendor/x86_64-pc-windows-msvc/bin/codex.exe`. The existing command-isolation tests successfully execute the direct native CLI.
- Cancellation and timeout use the same two-stage termination state machine while retaining distinct ordinary result codes. A one-second graceful deadline is followed by `SIGKILL` and a separate one-second force deadline.
- `kill()` return values, `child.killed`, and `exit` are never treated as the resource-release boundary. Only `close` yields ordinary `CANCELLED` or `TIMEOUT`; duplicate lifecycle events cannot double-settle.
- If force termination remains unverified, the runner returns fixed `TERMINATION_FAILED` with `childMayBeRunning: true`. Output-schema and prepared-image cleanup are withheld while a possibly live process or inherited stdio remains open. The error carries an internal `cleanupWhenSafe` promise; a guarded late-close reaper removes both quarantined resources exactly once if `close` eventually arrives.
- The fatal API result is fixed `500 codex_termination_failed`; stderr, command details, image URL, and temporary paths cannot enter the response or allowlisted call log.
- Timeout and abort listeners/timers are removed at bounded request settlement. On the fatal path, bounded stdout/stderr plus `error`/`close` listeners intentionally remain as the late reaper and are removed when `close` arrives; ordinary paths remove all listeners on settlement.

### Final lifecycle review RED and correction

The independent final review found that the first GREEN implementation still treated `exit` as sufficient and removed all process listeners on the bounded fatal response. Node can emit `exit` before inherited stdio closes, and removing the final `close` listener made quarantined files permanent even if the process later closed.

The final two-file RED was:

```powershell
npm test -- --run test/codexRunner.test.ts test/server.test.ts
```

Exit 1: 3 tests failed and 59 passed. The runner settled on `exit`, removed its late `close`/`error` listeners, and the server never cleaned the prepared image after a simulated late close.

After the correction, the same command exited 0 with 2 files / 62 tests. The force test now proves `exit` does not settle, the fatal schema test proves schema retention through `exit` and deletion after late `close`, and the server test proves the image remains quarantined until the same safety signal resolves. All child/stream listeners are then removed.

### Finding 2 RED: additional image syntax bypass

The former scanner stopped exploring message siblings when `content` was an array and stopped exploring properties after recognizing a valid image object. Eight new compatibility/server regressions demonstrated successful normalization or HTTP 200 for:

- an accepted direct image plus an image in a message sibling;
- an image nested inside an otherwise valid direct image object;
- an image in a top-level Responses property outside `input`;
- an image in a Chat property outside `messages`.

Each server case also asserted zero fetch and zero Codex runner calls.

```powershell
npm test -- --run test/openaiCompat.test.ts test/server.test.ts
```

Initial exit 1: 8 new tests failed and 71 passed. After the full-body parser change, exit 0: 2 files / 79 tests passed.

### Finding 2 GREEN: sole accepted occurrence

- The iterative scanner uses an object-identity visited set, terminates on cycles, and traverses every enumerable property of every array/object, including recognized image objects and message siblings.
- Responses separately identifies direct message-content image parts, then requires exactly one full-body occurrence, exactly one direct part, and identity equality between them.
- The accepted part must still have a string `image_url` and no `file_id`; duplicate direct images retain the bounded `multiple_input_images` error.
- All other Responses occurrences return HTTP 400 `invalid_input_image` with `param: input`; every Chat occurrence returns HTTP 400 `unsupported_chat_image` with `param: messages`, before fetch or runner invocation.

### Fix Round 1 verification

```powershell
npm test -- --run test/safeRemoteImage.test.ts test/openaiCompat.test.ts test/server.test.ts test/codexRunner.test.ts test/config.test.ts test/codexCliIsolation.test.ts
```

Exit 0: 6 files / 183 tests passed.

```powershell
npm test
```

Exit 0: all 9 files / 221 tests passed.

```powershell
npm run typecheck
npm run build
git diff --check
```

All exited 0. TypeScript emitted no diagnostics. The diff check was clean; Git printed only the repository's configured LF-to-CRLF notices.

The independent reviewer re-checked the close-only boundary, late-close reaper, full-body occurrence validation, and cleanup/logging behavior after the correction and returned: `No blocking findings.`

### Fix Round 1 files

- Modified production: `src/codexRunner.ts`, `src/config.ts`, `src/openaiCompat.ts`, `src/server.ts`
- Modified tests: `test/codexRunner.test.ts`, `test/config.test.ts`, `test/openaiCompat.test.ts`, `test/server.test.ts`
- Appended report: `.superpowers/sdd/2026-08-10-capability-constrained-api/task-3-report.md`

### Fix Round 1 self-review and concern

- The direct native resolver remains fail-closed: unsupported targets, missing optional packages, wrong package versions, or escaped/missing binaries throw during command resolution; no ambient executable fallback was added.
- The termination tests distinguish a reported signal attempt and `exit` from verified stream closure, cover ignored graceful termination and `kill() === false`, and prove temporary cleanup does not race an unverified child or inherited stdio.
- The syntax tests cover every reported bypass location and prove rejection precedes all fetch/runner effects.
- No known blocker remains. The intentional fatal fallback retains an image/schema directory while native-process closure cannot be verified, then a late-close reaper cleans both resources. If `close` never arrives, the quarantine remains; that is preferable to deleting a file that a possibly live process or descendant-held stream still uses. It is reported as `codex_termination_failed`, not as successful cancellation or cleanup.

## Fix Round 2

### Finding and root cause

The Fix Round 1 full-body scanner remained iterative and cycle-safe, but it used argument spread to enqueue every child of an array:

```ts
pending.push(...current);
```

V8 applies an argument-count/stack limit to that call even though the scanner itself does not recurse. A valid Responses body containing 130,000 one-character input items is only 520,011 bytes, below Fastify's default 1 MiB body limit, but it raised `RangeError: Maximum call stack size exceeded`. The analogous malformed-image body is 520,063 bytes and reached the generic server error path as HTTP 500 instead of the required bounded HTTP 400.

The first minimal scanner fix exposed the same width-dependent argument spread one layer later in prompt construction at `lines.push(...formattedInput.lines)`. Both untrusted-width spreads had to be removed for broad valid input to normalize fully.

### TDD RED evidence

Baseline before the new regressions:

```powershell
npm test -- --run test/openaiCompat.test.ts test/server.test.ts
```

Exit 0: 2 files / 80 tests passed.

After adding the broad valid and broad malformed-image cases, the same command exited 1 with 2 failures and 80 passes:

- the valid normalization case threw `RangeError` from `findInputImageOccurrences()` at the spread enqueue;
- the malformed-image route returned 500 instead of 400. The request remained below the Fastify body limit, and the test required zero image-fetch and zero Codex-runner calls.

After replacing only the scanner enqueue, the server case passed but the valid case remained RED with `RangeError` at `lines.push(...formattedInput.lines)`. This confirmed a second occurrence of the same argument-width root cause rather than a recursive scanner failure.

### GREEN implementation

- `findInputImageOccurrences()` now iterates each array/object child and pushes it individually onto the existing explicit stack.
- `normalizeResponsesRequest()` likewise appends each formatted input line individually.
- Traversal remains iterative and object-identity cycle-safe. Child order, the occurrence list, the direct-part identity comparison, and sole-image validation semantics are unchanged.
- The broad valid request now normalizes to the hand-derived prompt length with no image and web search disabled.
- The broad malformed request returns HTTP 400 `invalid_input_image` with `param: input`, before any fetch or runner call.

Focused GREEN:

```powershell
npm test -- --run test/openaiCompat.test.ts test/server.test.ts
```

Exit 0: 2 files / 82 tests passed.

### Fix Round 2 verification

```powershell
npm test -- --run test/safeRemoteImage.test.ts test/openaiCompat.test.ts test/server.test.ts test/codexRunner.test.ts test/config.test.ts test/codexCliIsolation.test.ts
```

Exit 0: 6 files / 185 tests passed.

```powershell
npm test
```

Exit 0: all 9 files / 223 tests passed.

```powershell
npm run typecheck
npm run build
git diff --check
```

All exited 0. TypeScript emitted no diagnostics. The diff check was clean; Git printed only the repository's configured LF-to-CRLF notices.

### Fix Round 2 files and self-review

- Modified production: `src/openaiCompat.ts`
- Modified tests: `test/openaiCompat.test.ts`, `test/server.test.ts`
- Appended report: `.superpowers/sdd/2026-08-10-capability-constrained-api/task-3-report.md`
- The mutation check is direct: restoring either width-dependent spread makes the broad valid test fail; restoring the scanner spread also changes the broad malformed route from bounded 400 to 500.
- No service, port, network, DNS, database, deployment, or production state was touched. No known blocker or new residual concern remains from this fix.
