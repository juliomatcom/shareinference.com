import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sourceProblems, submoduleGitlink } from "../scripts/verify-build.mjs";

const W = "a".repeat(40);
const L = "b".repeat(40);
const refs = { wllama: { commit: W }, llamaCpp: { tag: "b12613", commit: L }, emsdk: "4.0.20" };
const buildMd = (w = W, tag = "b12613", l = L, emsdk = "4.0.20") =>
  [
    "## Sources",
    "",
    `- wllama: https://github.com/x/wllama branch \`shareinference\` (base 3.13.0), commit ${w}`,
    `- llama.cpp: tag ${tag}, commit ${l}`,
    `- emsdk: ${emsdk}`,
    "- emdawnwebgpu: v1 (https://example.com/p.zip), sha256 " + "c".repeat(64),
  ].join("\n");

test("matching sources have no problems", () => {
  assert.deepEqual(sourceProblems(buildMd(), refs), []);
});

test("each recorded source that differs from refs.json is reported", () => {
  assert.equal(sourceProblems(buildMd("d".repeat(40)), refs).length, 1);
  assert.match(sourceProblems(buildMd(W, "b1"), refs)[0], /llama\.cpp tag/);
  assert.match(sourceProblems(buildMd(W, "b12613", "e".repeat(40)), refs)[0], /llama\.cpp commit/);
  assert.match(sourceProblems(buildMd(W, "b12613", L, "4.0.21"), refs)[0], /emsdk/);
  assert.equal(sourceProblems(buildMd("d".repeat(40), "b1", "e".repeat(40), "9"), refs).length, 4);
});

test("a BUILD.md without the lines is a problem, not a pass", () => {
  assert.equal(sourceProblems("# nothing", refs).length, 4);
});

test("the gitlink check is skipped (null) outside a git repository or without the path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "no-git-"));
  writeFileSync(path.join(dir, "x"), "");
  assert.equal(submoduleGitlink(dir), null);
});
