// Builds the browser engine (wllama + llama.cpp compiled to wasm with WebGPU) from the pinned submodule and writes
// vendor/<engineId>/. Output is committed, so only whoever upgrades the engine needs this toolchain.
// Needs: git submodule `wllama` checked out at refs.json's commit, emsdk (version in refs.json) at $EMSDK (installed
// outside the repo), cmake, make, python3, unzip, node + npm. Usage: pnpm --filter @shareinference/wllama-webgpu build:engine
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const refs = JSON.parse(await readFile(path.join(lib, "build/refs.json"), "utf8"));
const src = path.join(lib, "wllama");
// Downloads and CMake output live here (git-ignored); deleting it only costs a rebuild.
const cache = path.join(lib, ".build-cache");
const outDir = path.join(lib, "vendor", refs.engineId);
const say = (text) => process.stdout.write(`${text}\n`);
const fail = (text) => {
  process.stderr.write(`build:engine: ${text}\n`);
  process.exit(1);
};

const emsdk = process.env.EMSDK;
if (!emsdk || !existsSync(path.join(emsdk, "upstream/emscripten/emcc"))) {
  fail(
    `set EMSDK to an emsdk ${refs.emsdk} install outside this repo, for example:\n` +
      `  git clone https://github.com/emscripten-core/emsdk ~/emsdk && cd ~/emsdk && ./emsdk install ${refs.emsdk} && ./emsdk activate ${refs.emsdk}\n` +
      `  export EMSDK=~/emsdk`,
  );
}
const nodeDir = path.join(emsdk, "node");
const emsdkNode = existsSync(nodeDir) ? readdirSync(nodeDir).map((d) => path.join(nodeDir, d, "bin")) : [];
// What emsdk_env.sh would export: emscripten reads its tool paths from the .emscripten file EM_CONFIG names.
const env = {
  ...process.env,
  EM_CONFIG: path.join(emsdk, ".emscripten"),
  PATH: [
    path.join(emsdk, "upstream/emscripten"),
    path.join(emsdk, "upstream/bin"),
    ...emsdkNode,
    process.env.PATH,
  ].join(path.delimiter),
};

function run(cmd, args, options = {}) {
  say(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env, ...options });
  if (r.status !== 0) fail(`${cmd} ${args[0] ?? ""} failed (exit ${r.status ?? r.signal})`);
}
function out(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env, ...options });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trimEnd();
}
const sha256 = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

// ---- toolchain and sources ------------------------------------------------------------------------------------------

const emccVersion = /emcc .* (\d+\.\d+\.\d+)/.exec(out("emcc", ["--version"]))?.[1];
if (emccVersion !== refs.emsdk) {
  fail(`emsdk ${refs.emsdk} required, found ${emccVersion}. Newer emscripten versions fail to link this build.`);
}
if (!existsSync(path.join(src, ".git"))) {
  fail("the wllama submodule is missing: run `git submodule update --init libs/wllama-webgpu/wllama`.");
}
const head = out("git", ["-C", src, "rev-parse", "HEAD"]);
if (head !== refs.wllama.commit) {
  fail(
    `wllama is at ${head}, refs.json pins ${refs.wllama.commit}: run \`git submodule update libs/wllama-webgpu/wllama\`.`,
  );
}
// The build rewrites these two tracked files (emscripten glue embedded for the bundle); anything else dirty is a
// patch that was never committed to the fork.
const GENERATED = new Set(["src/wasm/wllama.js", "src/workers-code/generated.ts"]);
const dirty = out("git", ["-C", src, "status", "--porcelain", "--untracked-files=no"])
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(3))
  .filter((file) => !GENERATED.has(file));
if (dirty.length > 0) fail(`wllama has uncommitted changes (${dirty.join(", ")}); commit them to the fork and re-pin.`);
run("git", ["-C", src, "submodule", "update", "--init", "--depth", "1", "llama.cpp"]);
const llama = out("git", ["-C", path.join(src, "llama.cpp"), "rev-parse", "HEAD"]);
if (llama !== refs.llamaCpp.commit) fail(`llama.cpp is at ${llama}, refs.json pins ${refs.llamaCpp.commit}.`);

// ---- dawn (emdawnwebgpu) --------------------------------------------------------------------------------------------

const dawnZip = path.join(cache, `emdawnwebgpu_pkg-${refs.dawn.tag}.zip`);
const dawnDir = path.join(cache, `emdawn-${refs.dawn.tag}`);
await mkdir(cache, { recursive: true });
if (!existsSync(path.join(dawnDir, "emdawnwebgpu_pkg"))) {
  if (!existsSync(dawnZip)) {
    const res = await fetch(refs.dawn.url);
    if (!res.ok) fail(`download of ${refs.dawn.url} failed: ${res.status}`);
    await writeFile(dawnZip, Buffer.from(await res.arrayBuffer()));
  }
  if ((await sha256(dawnZip)) !== refs.dawn.sha256) fail(`${dawnZip} does not match the sha256 in refs.json.`);
  await rm(dawnDir, { recursive: true, force: true });
  run("unzip", ["-q", dawnZip, "-d", dawnDir]);
}

// ---- wasm -----------------------------------------------------------------------------------------------------------

const buildDir = path.join(cache, "cmake");
const PREFIX_MAPS = `-ffile-prefix-map=${src}=wllama -ffile-prefix-map=${cache}=build`;
await rm(buildDir, { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });
// Run inside the build directory: emscripten's compiler probe writes a.out.* into the working directory.
run(
  "emcmake",
  [
    "cmake",
    src,
    ...refs.cmakeFlags,
    `-DEMDAWNWEBGPU_DIR=${path.join(dawnDir, "emdawnwebgpu_pkg")}`,
    // __FILE__ in asserts and logs would otherwise put this machine's absolute paths into the committed wasm.
    `-DCMAKE_C_FLAGS=${PREFIX_MAPS}`,
    `-DCMAKE_CXX_FLAGS=${PREFIX_MAPS}`,
  ],
  { cwd: buildDir },
);
run("emmake", ["make", "wllama", `-j${os.availableParallelism()}`], { cwd: buildDir });

// ---- package (what wllama's own `build:wasm` + `build` scripts do after the compile) ---------------------------------

await mkdir(path.join(src, "src/wasm"), { recursive: true });
await cp(path.join(buildDir, "wllama.js"), path.join(src, "src/wasm/wllama.js"));
run("node", ["scripts/add_wasm_names.js", path.join(buildDir, "wllama.wasm"), path.join(src, "src/wasm/wllama.wasm")], {
  cwd: src,
});
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: src });
run("npm", ["run", "build:glue"], { cwd: src });
run("./scripts/build_worker.sh", [], { cwd: src });
// A single self-contained ES module: the engine loads it from our origin, so no relative imports may remain.
run("npx", ["tsup", "src/index.ts", "--format", "esm"], { cwd: src });
const bundle = path.join(src, "esm/index.js");
const index = await readFile(bundle, "utf8");
if (/^\s*import\b/m.test(index) || index.includes('from "./') || index.includes("from './")) {
  fail("wllama index.js has relative imports; it must be a single self-contained file.");
}

// The output is committed to a public repository: no path of this machine may be in it.
for (const file of [bundle, path.join(src, "src/wasm/wllama.wasm")]) {
  const text = (await readFile(file)).toString("latin1");
  for (const secret of [lib, os.homedir()]) {
    if (text.includes(secret)) fail(`${path.relative(lib, file)} contains the local path ${secret}.`);
  }
}

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(outDir, "wllama/wasm"), { recursive: true });
await cp(bundle, path.join(outDir, "wllama/index.js"));
await cp(path.join(src, "src/wasm/wllama.wasm"), path.join(outDir, "wllama/wasm/wllama.wasm"));

// ---- BUILD.md (sync-assets checks the copied files and these sources against it before serving) -------------------------------------------

const files = ["wllama/index.js", "wllama/wasm/wllama.wasm"];
const lines = [];
for (const file of files) {
  lines.push(
    `- ${file}: ${(await stat(path.join(outDir, file))).size} bytes, sha256 ${await sha256(path.join(outDir, file))}`,
  );
}
await writeFile(
  path.join(outDir, "BUILD.md"),
  [
    `# ${refs.engineId}`,
    "",
    "Generated by `pnpm --filter @shareinference/wllama-webgpu build:engine`; do not edit.",
    "",
    "## Sources",
    "",
    `- wllama: ${refs.wllama.fork} branch \`${refs.wllama.branch}\` (base ${refs.wllama.base}), commit ${refs.wllama.commit}`,
    `- llama.cpp: tag ${refs.llamaCpp.tag}, commit ${refs.llamaCpp.commit}`,
    `- emsdk: ${refs.emsdk}`,
    `- emdawnwebgpu: ${refs.dawn.tag} (${refs.dawn.url}), sha256 ${refs.dawn.sha256}`,
    "",
    "## Flags",
    "",
    `\`emcmake cmake ${refs.cmakeFlags.join(" ")} -DEMDAWNWEBGPU_DIR=<emdawnwebgpu_pkg>\`, with the file paths of the build machine mapped away (\`-ffile-prefix-map\`), then \`make wllama\`. Release build; wllama's own CMake options (-O3, memory64, JSPI, wasm exceptions) apply.`,
    "",
    "## Files",
    "",
    ...lines,
    "",
  ].join("\n"),
);
say(`engine built: ${path.relative(process.cwd(), outDir)}`);
