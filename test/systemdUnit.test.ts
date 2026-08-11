import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type UnitSections = Map<string, Map<string, string[]>>;

function parseUnit(contents: string): UnitSections {
  const sections: UnitSections = new Map();
  let currentSection: Map<string, string[]> | undefined;

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      currentSection = new Map();
      sections.set(sectionMatch[1], currentSection);
      continue;
    }

    const separator = line.indexOf("=");
    if (!currentSection || separator < 1) {
      throw new Error(`Malformed systemd unit line: ${rawLine}`);
    }

    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    currentSection.set(key, [...(currentSection.get(key) ?? []), value]);
  }

  return sections;
}

function single(section: Map<string, string[]>, key: string): string {
  const values = section.get(key);
  expect(values, `missing ${key}`).toHaveLength(1);
  return values![0];
}

describe("production systemd unit", () => {
  it("runs the loopback-only service inside the dedicated filesystem boundary", () => {
    const unit = parseUnit(
      readFileSync(join(process.cwd(), "deploy", "codexapi.service"), "utf8"),
    );
    const service = unit.get("Service");
    expect(service, "missing [Service] section").toBeDefined();

    expect(single(service!, "User")).toBe("codexapi");
    expect(single(service!, "Group")).toBe("codexapi");
    expect(single(service!, "WorkingDirectory")).toBe("/opt/ludora/codexapi");

    expect(service!.get("Environment")).toEqual(
      expect.arrayContaining([
        "HOST=127.0.0.1",
        "PORT=3001",
        "HOME=/var/lib/codexapi",
        "CODEX_HOME=/var/lib/codexapi/home",
        "CODEX_WORKSPACE=/var/lib/codexapi/workspace",
      ]),
    );
    expect(service!.has("EnvironmentFile")).toBe(false);

    expect(single(service!, "NoNewPrivileges")).toBe("true");
    expect(single(service!, "ProtectSystem")).toBe("strict");
    expect(single(service!, "PrivateTmp")).toBe("true");
    expect(single(service!, "ProtectHome")).toBe("true");
    expect(single(service!, "ReadOnlyPaths")).toBe("/opt/ludora/codexapi");
    expect(service!.get("InaccessiblePaths")).toEqual([
      "/opt/ludora/ludora-admin /home/robertorojas87",
    ]);
    expect(service!.get("ReadWritePaths")).toEqual(["/var/lib/codexapi"]);
  });
});
