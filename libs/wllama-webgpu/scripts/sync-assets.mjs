// Copies the committed engine build (vendor/<engineId>/) and our engine sources into apps/web/public/engine/ so they are
// served from our origin. The folder name carries the engine id, which lets the build files be cached as immutable.
// The vendor files are checked against BUILD.md first: a hand-edited or half-updated vendor folder must not ship. This
// proves the copy is the recorded build (integrity), not that the build came from the pinned sources: see the engine
// upgrade checklist in wiki-llm/setup.md for that.
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceProblems, submoduleGitlink } from "./verify-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const refs = JSON.parse(await readFile(path.join(root, "build/refs.json"), "utf8"));
const { engineId } = refs;
const vendor = path.join(root, "vendor", engineId);
const engines = path.resolve(root, "../../apps/web/public/engine");
const out = path.join(engines, engineId);

const buildMd = await readFile(path.join(vendor, "BUILD.md"), "utf8").catch(() => {
  throw new Error(
    `${path.relative(root, vendor)}/BUILD.md is missing: run \`pnpm --filter @shareinference/wllama-webgpu build:engine\`.`,
  );
});
// Same engineId, different sources: the files are served immutable, so the id must change with them.
const problems = sourceProblems(buildMd, refs);
const gitlink = submoduleGitlink(root); // null without git (Docker build context): skipped
if (gitlink !== null && gitlink !== refs.wllama.commit) {
  problems.push(`wllama submodule gitlink is ${gitlink}, refs.json pins ${refs.wllama.commit}`);
}
if (problems.length > 0) {
  throw new Error(
    `build sources differ from build/refs.json (bump engineId and rebuild, or re-pin):\n- ${problems.join("\n- ")}`,
  );
}
const FILES = ["wllama/index.js", "wllama/wasm/wllama.wasm"];
for (const file of FILES) {
  const expected = new RegExp(`^- ${file.replace(/[./]/g, "\\$&")}: \\d+ bytes, sha256 ([0-9a-f]{64})$`, "m").exec(
    buildMd,
  )?.[1];
  const actual = createHash("sha256")
    .update(await readFile(path.join(vendor, file)))
    .digest("hex");
  if (!expected || expected !== actual)
    throw new Error(`${file} does not match the sha256 in BUILD.md; rebuild the engine.`);
}

// The worker imports the engine by this id; a bump in one place only would load a 404.
const worker = await readFile(path.resolve(root, "../../apps/web/public/share-worker.js"), "utf8");
if (!worker.includes(`/engine/${engineId}/engine.js`)) {
  throw new Error(`apps/web/public/share-worker.js must import /engine/${engineId}/engine.js.`);
}

const index = await readFile(path.join(vendor, "wllama/index.js"), "utf8");
if (/^\s*import\b/m.test(index) || index.includes('from "./') || index.includes("from './")) {
  throw new Error("wllama/index.js has relative imports; it must be a single self-contained file.");
}

await rm(engines, { recursive: true, force: true });
await mkdir(path.join(out, "wllama/wasm"), { recursive: true });
for (const file of FILES) await cp(path.join(vendor, file), path.join(out, file));
await cp(path.join(root, "src/engine.js"), path.join(out, "engine.js"));
await cp(path.join(root, "src/shader-patch.js"), path.join(out, "shader-patch.js"));
await cp(path.join(root, "src/completion.js"), path.join(out, "completion.js"));
await cp(path.join(root, "src/profiles.js"), path.join(out, "profiles.js"));
process.stdout.write(`engine assets synced to ${path.relative(process.cwd(), out)}\n`);
