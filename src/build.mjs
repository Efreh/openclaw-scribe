import { build } from "esbuild";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = dirname(fileURLToPath(import.meta.url));
const root = dirname(src);
const pkg = JSON.parse(await readFile(join(src, "package.json"), "utf8"));
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "browser"), { recursive: true });
await mkdir(join(dist, "plugin"), { recursive: true });
const common = { bundle: true, minify: true, legalComments: "eof", logLevel: "info", absWorkingDir: src };
await build({ ...common, entryPoints: ["extension/background.ts", "extension/popup.ts", "extension/offscreen.ts", "extension/worklet.ts", "extension/permission.ts"], outdir: join(dist, "browser"), format: "esm", platform: "browser", target: "chrome116" });
await build({ ...common, entryPoints: ["plugin/index.ts"], outfile: join(dist, "plugin/index.js"), format: "esm", platform: "node", target: "node24", external: ["openclaw/*", "bufferutil", "utf-8-validate"], banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
for (const name of ["popup.html", "offscreen.html", "permission.html", "style.css"]) {
  await cp(join(src, "extension", name), join(dist, "browser", name));
}
async function json(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
for (const [from, to] of [["extension/manifest.json", "browser/manifest.json"], ["plugin/openclaw.plugin.json", "plugin/openclaw.plugin.json"]]) {
  const manifest = JSON.parse(await readFile(join(src, from), "utf8"));
  await json(join(dist, to), { ...manifest, version: pkg.version });
}
await json(join(dist, "plugin/package.json"), {
  name: "@efreh/openclaw-scribe", version: pkg.version, type: "module", license: "MIT",
  description: "Local browser audio and native OpenClaw meeting transcripts",
  repository: { type: "git", url: "https://github.com/Efreh/openclaw-scribe.git" },
  engines: pkg.engines,
  peerDependencies: { openclaw: "2026.10.7" }, peerDependenciesMeta: { openclaw: { optional: true } },
  files: ["index.js", "openclaw.plugin.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES"],
  openclaw: {
    extensions: ["./index.js"],
    compat: { pluginApi: "2026.10.7", minGatewayVersion: "2026.10.7" },
    build: { openclawVersion: "2026.10.7", pluginSdkVersion: "2026.10.7" },
  },
});
for (const name of ["LICENSE", "README.md"]) await cp(join(root, name), join(dist, "plugin", name));
await writeFile(join(dist, "plugin/THIRD_PARTY_NOTICES"), `ws ${pkg.dependencies.ws}\n\n${await readFile(join(src, "node_modules/ws/LICENSE"), "utf8")}`);

if (process.argv.includes("--pack")) {
  const artifacts = join(root, "artifacts");
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });
  const files = {};
  async function collect(dir, prefix = "") {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await collect(join(dir, entry.name), `${name}/`);
      else files[name] = [new Uint8Array(await readFile(join(dir, entry.name))), { mtime: new Date("2026-01-01T00:00:00Z") }];
    }
  }
  await collect(join(dist, "browser"));
  await writeFile(join(artifacts, `openclaw-scribe-browser-${pkg.version}.zip`), zipSync(files, { level: 9 }));
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", artifacts], { cwd: join(dist, "plugin"), stdio: "inherit" });
  const hashes = [];
  for (const name of (await readdir(artifacts)).sort()) {
    hashes.push(`${createHash("sha256").update(await readFile(join(artifacts, name))).digest("hex")}  ${name}`);
  }
  await writeFile(join(artifacts, "SHA256SUMS"), `${hashes.join("\n")}\n`);
  console.log(`Artifacts: ${artifacts}`);
}
