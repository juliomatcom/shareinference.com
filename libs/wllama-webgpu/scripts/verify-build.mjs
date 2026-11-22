// Pure checks of vendor/<engineId>/BUILD.md against build/refs.json, used by sync-assets.mjs. The vendor files are served
// `immutable` under a path made from the engineId, so a rebuild from a new fork or llama.cpp commit that kept the old
// engineId (and its refs.json) would leave browsers with stale files: the sources BUILD.md records must be the pinned ones.
import { execFileSync } from "node:child_process";

const line = (buildMd, label) => new RegExp(`^- ${label}: (.+)$`, "m").exec(buildMd)?.[1];

/** Problems (strings) where the commits, tag and emsdk version BUILD.md records differ from refs.json; [] when they match. */
export function sourceProblems(buildMd, refs) {
  const wllama = line(buildMd, "wllama") ?? "";
  const llama = line(buildMd, "llama\\.cpp") ?? "";
  const emsdk = line(buildMd, "emsdk");
  const checks = [
    ["wllama commit", new RegExp(`, commit ([0-9a-f]{40})$`).exec(wllama)?.[1], refs.wllama.commit],
    ["llama.cpp tag", /^tag (\S+?),/.exec(llama)?.[1], refs.llamaCpp.tag],
    ["llama.cpp commit", /, commit ([0-9a-f]{40})$/.exec(llama)?.[1], refs.llamaCpp.commit],
    ["emsdk version", emsdk?.trim(), refs.emsdk],
  ];
  return checks
    .filter(([, recorded, pinned]) => recorded !== pinned)
    .map(([what, recorded, pinned]) => `${what}: BUILD.md records ${recorded ?? "nothing"}, refs.json pins ${pinned}`);
}

/**
 * The commit the wllama submodule is pinned to in the superproject, or null when git or the gitlink is unavailable (a
 * Docker build context has no .git, git may not be installed). `cwd` is the library folder.
 */
export function submoduleGitlink(cwd) {
  try {
    const out = execFileSync("git", ["ls-files", "-s", "--", "wllama"], { cwd, encoding: "utf8", stdio: "pipe" });
    return /^160000 ([0-9a-f]{40}) 0\twllama$/m.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}
