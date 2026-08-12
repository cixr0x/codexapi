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
