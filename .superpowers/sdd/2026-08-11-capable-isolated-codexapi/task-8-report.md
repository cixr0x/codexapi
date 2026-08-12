## Task 8 implementation report

Implemented the checked-in, database-free CodexAPI isolation verifier.

- Added `src/isolationCanary.ts`, a dependency-injected verifier with no endpoint or path arguments. It refuses non-Linux/non-root execution, uses only `http://127.0.0.1:3001/v1/responses`, creates exclusive mode-`0600` disposable markers in the four required protected roots, starts a random-port loopback nonce server, and submits one strict structured-output hostile request.
- The verifier fails closed on marker/private-nonce disclosure in raw HTTP or final output, any `ACCESS_OBTAINED` report, private-server access, outside-target creation, nonempty request workspace, missed cancellation child observation, or bounded cancellation cleanup failure. It closes the private server and removes only generated identity-known marker/outside paths in `finally`; cleanup errors remain path/secret-free.
- Added the cancellation probe: it begins a deliberately long public-research Responses request, waits for a request child under `/var/lib/codexapi/workspace`, aborts it, and requires cleanup within a fixed 2-second bound.
- Added `src/verifyIsolation.ts` and `npm run verify:isolation`, which runs the built command and emits exactly `{"status":"ok","isolation":"verified"}` on success. README documents the production-only `sudo` invocation.
- Added hermetic Vitest coverage for fixed endpoint/prompt secrecy/structured output, mode and exclusive marker creation, private nonce/access/outside-write failures, cleanup, Linux/root refusal, and bounded abort cleanup. No live model, production files, root permissions, network, database, SQL, credentials, or deployment were used by tests.

TDD evidence: the initial focused test was run before the module existed and failed with the expected missing `../src/isolationCanary.js` implementation. After implementation, focused tests passed.

Verification completed:

```text
npm test                         # 14 files passed; 320 passed, 1 skipped
npm run typecheck                # exit 0
npm run build                    # exit 0
git diff --check                 # exit 0
```

## Review round 1 remediation

Committed follow-up `PENDING_SHA` (replace with the commit SHA) resolves the isolation-canary review findings:

- Parses the production-shaped Responses envelope, examines only returned assistant output fields, JSON-parses `output_text`, and requires exactly the all-`ACCESS_DENIED` assessment. Schema metadata is never treated as model output.
- Adds fixed `/home` and `/home/robertorojas87` marker roots alongside the original protected paths; looks up the fixed `codexapi` service account, transfers each marker to that uid/gid, and restricts it to mode `0400` before the probe.
- Uses filename and content entropy independently. Cleanup checks recorded `(dev, ino, regular-file)` identity before unlinking each marker; replaced markers are preserved and fail closed. Model-created outside targets are never deleted automatically.
- Binds hostile I/O, server close, child observation, abort classification, and workspace cleanup to explicit bounded waits. Cancellation captures exactly one new request child and restores the original baseline child set after an `AbortError` rejection.
- Adds production-shaped, hermetic tests for malformed/missing/extra/obtained output, private hits and secret disclosure, partial account setup cleanup, replacement safety, normal-completion/concurrent-child cancellation false passes, hung hostile/server operations, all fixed roots/network targets, and exact CLI stdout.

Review-round verification:

```text
npm test                         # 15 files passed; 327 passed, 1 skipped
npm run typecheck                # exit 0
npm run build                    # exit 0
git diff --check                 # exit 0
```
