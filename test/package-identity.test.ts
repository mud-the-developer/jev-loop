import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function json(path: string) {
  try { return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")); }
  catch (error) { throw new Error(`Invalid package metadata fixture: ${path}`, { cause: error }); }
}

// Independent-product expectations; not a claim of a defect in upstream pi-loop.
describe("standalone jev-loop development package", () => {
  it("has its own source-only package identity and repository", () => {
    const manifest = json("../package.json");
    expect(manifest.name).toBe("jev-loop");
    expect(manifest.version).toBe("0.1.0-dev.0");
    expect(manifest.private).toBe(true);
    expect(manifest.repository.url).toBe("https://github.com/mud-the-developer/jev-loop.git");
  });

  it("keeps the lockfile identity synchronized without changing dependencies", () => {
    const manifest = json("../package.json");
    const lock = json("../package-lock.json");
    expect(lock.name).toBe(manifest.name);
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""].name).toBe(manifest.name);
    expect(lock.packages[""].version).toBe(manifest.version);
    expect(lock.packages[""].devDependencies).toEqual(manifest.devDependencies);
  });

  it("retains the upstream MIT attribution and has no automatic release workflow", () => {
    const license = readFileSync(new URL("../LICENSE", import.meta.url), "utf8");
    expect(license).toContain("Copyright (c) 2025 trevonistrevon");
    expect(license).toContain("MIT License");
    expect(existsSync(new URL("../.github/workflows/release.yml", import.meta.url))).toBe(false);
  });
});
