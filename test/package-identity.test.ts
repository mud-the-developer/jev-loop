import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function json(path: string) {
  try { return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")); }
  catch (error) { throw new Error(`Invalid package metadata fixture: ${path}`, { cause: error }); }
}

// Independent-product expectations; not a claim of a defect in upstream pi-loop.
describe("standalone jev-loop GitHub release", () => {
  it("has its own released package identity while retaining the npm publication guard", () => {
    const manifest = json("../package.json");
    expect(manifest.name).toBe("jev-loop");
    expect(manifest.version).toBe("0.1.3");
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

  it("pins the compatible undici security patch without downgrading the development SDK", () => {
    const manifest = json("../package.json"); const lock = json("../package-lock.json");
    expect(manifest.devDependencies["@earendil-works/pi-coding-agent"]).toBe("1.2.0");
    expect(manifest.overrides?.undici).toBe("8.12.3");
    expect(lock.packages["node_modules/undici"].version).toBe("8.12.3");
    expect(lock.packages["node_modules/@earendil-works/pi-coding-agent"].version).toBe("1.2.0");
  });

  it("documents a pinned release artifact, checksum validation and tagged source installation", () => {
    expect(json("../package.json").files).toContain("docs/LOOP_ACCESS_CONTRACT.md");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("releases/download/v0.1.3/jev-loop-0.1.3.tgz");
    expect(readme).toContain("sha256sum -c SHA256SUMS");
    expect(readme).toContain("--branch v0.1.3");
    expect(readme).toContain("blob/v0.1.3/AGENTS.md");
    expect(readme).not.toContain("source-only and private");
  });

  it("keeps machine-local probe locations out of shipped documentation", () => {
    const manifest = json("../package.json");
    for (const name of manifest.files.filter((name: string) => name.endsWith(".md"))) {
      expect(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"), name).not.toMatch(/\/tmp\/jev-loop-|\/home\/mud/);
    }
  });

  it("retains the upstream MIT attribution and has no automatic release workflow", () => {
    const license = readFileSync(new URL("../LICENSE", import.meta.url), "utf8");
    expect(license).toContain("Copyright (c) 2025 trevonistrevon");
    expect(license).toContain("MIT License");
    expect(existsSync(new URL("../.github/workflows/release.yml", import.meta.url))).toBe(false);
  });
});
