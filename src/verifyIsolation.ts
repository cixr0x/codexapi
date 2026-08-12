import { IsolationCanaryError, runIsolationCanary } from "./isolationCanary.js";

runIsolationCanary()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
  .catch((error: unknown) => {
    const message = error instanceof IsolationCanaryError
      ? error.message
      : "Isolation verification failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
