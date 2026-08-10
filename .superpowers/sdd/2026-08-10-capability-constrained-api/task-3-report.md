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
