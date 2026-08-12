import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const profile = readFileSync(
  new URL("../deploy/codexapi-runtime.config.toml", import.meta.url),
  "utf8",
);

interface TomlAssignment {
  key: string;
  value: string;
}

interface TomlTable {
  name: string;
  assignments: TomlAssignment[];
}

const tomlTables = parseTomlTables(profile);

describe("CodexAPI capable runtime profile", () => {
  it("defines the fixed capable-isolated runtime boundary", () => {
    expect(profile).toContain('default_permissions = "codexapi-runtime"');
    expect(profile).toContain('web_search = "live"');
    expect(profile).toContain("suppress_unstable_features_warning = true");
    expect(profile).toContain("view_image = true");
    expect(profile).toContain('"/opt/ludora/ludora-admin" = "deny"');
    expect(profile).toContain('"/var/lib/codexapi/home" = "deny"');
    expect(profile).toContain("allow_local_binding = false");
    expect(profile).toContain('"metadata.google.internal" = "deny"');

    expect(profile).not.toContain("danger-full-access");
  });

  it("sets limited mode in the CodexAPI runtime network table", () => {
    expect(tableAssignments("permissions.codexapi-runtime.network", "mode")).toEqual([
      { key: "mode", value: "limited" },
    ]);
  });

  it("grants write only in the request workspace roots table", () => {
    expect(allAssignments("write")).toEqual([
      {
        table: 'permissions.codexapi-runtime.filesystem.":workspace_roots"',
        key: '"."',
        value: "write",
      },
    ]);
  });
});

function parseTomlTables(source: string): TomlTable[] {
  return source
    .split(/(?=^\[[^\r\n]+\][ \t]*$)/m)
    .flatMap((section) => {
      const lines = section.split(/\r?\n/);
      const header = /^\[([^\]]+)\][ \t]*$/.exec(lines[0] ?? "");
      if (!header) {
        return [];
      }

      return [{
        name: header[1]!,
        assignments: lines.slice(1).flatMap((line) => {
          const assignment = /^[ \t]*([^#=\r\n]+?)[ \t]*=[ \t]*"([^"]*)"[ \t]*$/.exec(
            line,
          );
          return assignment
            ? [{ key: assignment[1]!.trim(), value: assignment[2]! }]
            : [];
        }),
      }];
    });
}

function tableAssignments(tableName: string, key: string): TomlAssignment[] {
  const table = tomlTables.find((candidate) => candidate.name === tableName);
  expect(table, `missing TOML table [${tableName}]`).toBeDefined();
  return table!.assignments.filter((assignment) => assignment.key === key);
}

function allAssignments(value: string): Array<TomlAssignment & { table: string }> {
  return tomlTables.flatMap((table) =>
    table.assignments
      .filter((assignment) => assignment.value === value)
      .map((assignment) => ({ table: table.name, ...assignment })),
  );
}
