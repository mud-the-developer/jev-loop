import { readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const result = await build({
  absWorkingDir: root,
  entryPoints: { index: "src/index.ts", api: "src/api.ts" },
  outdir: "dist", chunkNames: "chunks/[name]-[hash]",
  bundle: true, splitting: true, format: "esm", platform: "node", target: "es2022",
  // Host-provided packages must retain the host's classes and registries.
  packages: "external", keepNames: true, sourcemap: true, metafile: true,
});
const emitted = new Set(Object.keys(result.metafile.outputs).map(path => resolve(root, path)));
function removeLegacyJavaScript(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) removeLegacyJavaScript(path);
    else if ((path.endsWith(".js") || path.endsWith(".js.map")) && !emitted.has(path)) rmSync(path);
  }
}
// tsc declarations still describe the public API; unsupported deep JS entries do not ship twice.
removeLegacyJavaScript(dist);
console.log(`bundle: ${[...emitted].filter(path => path.endsWith(".js")).map(path => relative(dist, path)).join(", ")}; peer packages external`);
