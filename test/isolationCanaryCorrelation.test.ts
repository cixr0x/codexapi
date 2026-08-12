import { describe, expect, it } from "vitest";

import { isolationCanaryWorkspaceTag } from "../src/isolationCanaryCorrelation.js";

describe("isolationCanaryWorkspaceTag", () => {
  it("derives an opaque bounded tag only for a UUID from loopback", () => {
    const tag = isolationCanaryWorkspaceTag("123e4567-e89b-42d3-a456-426614174000", "127.0.0.1");
    expect(tag).toMatch(/^canary-[a-f0-9]{32}$/);
    expect(tag).not.toContain("123e4567");
  });

  it.each([
    ["invalid UUID", "nope", "127.0.0.1"],
    ["non-loopback", "123e4567-e89b-42d3-a456-426614174000", "10.0.0.2"],
  ])("rejects %s", (_name, value, address) => {
    expect(isolationCanaryWorkspaceTag(value, address)).toBeUndefined();
  });
});
