import { describe, expect, it } from "vitest";

import { verifyIsolationMain } from "../src/verifyIsolation.js";

describe("verifyIsolationMain", () => {
  it("writes exactly one success JSON line and nothing else to stdout", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await verifyIsolationMain({
      run: async () => ({ status: "ok", isolation: "verified" }),
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("{\"status\":\"ok\",\"isolation\":\"verified\"}\n");
    expect(stderr).toBe("");
  });
});
