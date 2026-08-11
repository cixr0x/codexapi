import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const profile = readFileSync(
  new URL("../deploy/codexapi-runtime.config.toml", import.meta.url),
  "utf8",
);

describe("CodexAPI capable runtime profile", () => {
  it("defines the fixed capable-isolated runtime boundary", () => {
    expect(profile).toContain('default_permissions = "codexapi-runtime"');
    expect(profile).toContain('web_search = "live"');
    expect(profile).toContain("view_image = true");
    expect(profile).toContain('"/opt/ludora/ludora-admin" = "deny"');
    expect(profile).toContain('"/var/lib/codexapi/home" = "deny"');
    expect(profile).toContain('"." = "write"');
    expect(profile).toContain("allow_local_binding = false");
    expect(profile).toContain('"metadata.google.internal" = "deny"');

    expect(profile).not.toContain("danger-full-access");
    expect(profile).not.toContain('network.mode = "full"');

    const filesystemWriteRules = [
      ...profile.matchAll(/^[ \t]*([^#=\r\n]+?)[ \t]*=[ \t]*"write"[ \t]*$/gm),
    ];
    expect(filesystemWriteRules).toHaveLength(1);
    expect(filesystemWriteRules[0]?.[1]?.trim()).toBe('"."');
  });
});
