import type { Stats } from "node:fs";

import { describe, expect, it } from "vitest";
import { CODEXAPI_LINUX_ARTIFACT_ALIAS, resolveLinuxCodexArtifactAlias } from "../src/config.js";

type ArtifactStat = Pick<Stats, "dev" | "ino" | "mode" | "isDirectory" | "isFile" | "isSymbolicLink">;
const aliasCommand = `${CODEXAPI_LINUX_ARTIFACT_ALIAS}/bin/codex`;

function fixture(triple = "x86_64-unknown-linux-musl") {
  const sourceRoot = `/opt/ludora/codexapi/node_modules/@openai/native/vendor/${triple}`;
  const sourceCommand = `${sourceRoot}/bin/codex`;
  const paths = new Map<string, ArtifactStat>([
    [sourceRoot, metadata("directory", 101)],
    [CODEXAPI_LINUX_ARTIFACT_ALIAS, metadata("directory", 101)],
    [sourceCommand, metadata("file", 102)],
    [aliasCommand, metadata("file", 102)],
  ]);
  const filesystem = {
    canonicalPath: (path: string) => path,
    inspectPath: (path: string) => {
      const entry = paths.get(path);
      if (!entry) throw new Error("missing fixture path");
      return entry;
    },
  };
  return { sourceRoot, sourceCommand, paths, filesystem };
}

function metadata(kind: "directory" | "file" | "symlink", ino: number): ArtifactStat {
  return {
    dev: 1, ino, mode: 0o755,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

describe("pinned Linux Codex artifact alias", () => {
  it.each(["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"])(
    "accepts only the same directory and executable inodes for %s",
    (triple) => {
      const f = fixture(triple);
      expect(resolveLinuxCodexArtifactAlias(f.sourceRoot, f.sourceCommand, f.filesystem)).toBe(aliasCommand);
    },
  );

  it.each(["directory", "executable"])("rejects a missing alias %s", (kind) => {
    const f = fixture();
    f.paths.delete(kind === "directory" ? CODEXAPI_LINUX_ARTIFACT_ALIAS : aliasCommand);
    expect(() => resolveLinuxCodexArtifactAlias(f.sourceRoot, f.sourceCommand, f.filesystem)).toThrow(/artifact alias is missing or does not match/);
  });

  it.each([
    ["directory inode", CODEXAPI_LINUX_ARTIFACT_ALIAS, "ino"],
    ["directory device", CODEXAPI_LINUX_ARTIFACT_ALIAS, "dev"],
    ["executable inode", aliasCommand, "ino"],
    ["executable device", aliasCommand, "dev"],
  ] as const)("rejects a different %s despite unchanged package metadata", (_, path, key) => {
    const f = fixture();
    f.paths.set(path, { ...f.paths.get(path)!, [key]: 999 });
    expect(() => resolveLinuxCodexArtifactAlias(f.sourceRoot, f.sourceCommand, f.filesystem)).toThrow(/artifact alias is missing or does not match/);
  });

  it.each(["source directory", "alias directory", "source executable", "alias executable"])(
    "rejects a symlink or wrong file type at %s",
    (location) => {
      const f = fixture();
      const path = location === "source directory" ? f.sourceRoot
        : location === "alias directory" ? CODEXAPI_LINUX_ARTIFACT_ALIAS
        : location === "source executable" ? f.sourceCommand : aliasCommand;
      for (const kind of ["symlink", location.includes("directory") ? "file" : "directory"] as const) {
        f.paths.set(path, metadata(kind, location.includes("directory") ? 101 : 102));
        expect(() => resolveLinuxCodexArtifactAlias(f.sourceRoot, f.sourceCommand, f.filesystem)).toThrow(/artifact alias is missing or does not match/);
      }
    },
  );

  it.each(["source", "alias"])("rejects a non-executable %s binary", (location) => {
    const f = fixture();
    const path = location === "source" ? f.sourceCommand : aliasCommand;
    f.paths.set(path, { ...f.paths.get(path)!, mode: 0o644 });
    expect(() => resolveLinuxCodexArtifactAlias(f.sourceRoot, f.sourceCommand, f.filesystem)).toThrow(/artifact alias is missing or does not match/);
  });

  it.each([CODEXAPI_LINUX_ARTIFACT_ALIAS, aliasCommand])("rejects an alias whose ancestor resolves elsewhere: %s", (path) => {
    const f = fixture();
    f.filesystem.canonicalPath = (candidate) => candidate === path ? "/untrusted/elsewhere" : candidate;
    expect(() => resolveLinuxCodexArtifactAlias(f.sourceRoot, f.sourceCommand, f.filesystem)).toThrow(/artifact alias is missing or does not match/);
  });
});
