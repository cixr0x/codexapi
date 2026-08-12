import { pathToFileURL } from "node:url";

import { IsolationCanaryError, runIsolationCanary, type IsolationCanaryResult } from "./isolationCanary.js";

export async function verifyIsolationMain({
  run = runIsolationCanary,
  stdout = (value: string) => process.stdout.write(value),
  stderr = (value: string) => process.stderr.write(value),
}: {
  run?: () => Promise<IsolationCanaryResult>;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
} = {}): Promise<number> {
  try {
    stdout(`${JSON.stringify(await run())}\n`);
    return 0;
  } catch (error: unknown) {
    stderr(`${error instanceof IsolationCanaryError ? error.message : "Isolation verification failed."}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void verifyIsolationMain().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
