import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REMOTE_COMPOSE,
  UsageError,
  imageTagFor,
  loadConfig,
  parseArgs,
  previousTagScript,
  promoteScript,
  rollbackHints,
  startScript,
  usage,
} from "./deploy.mjs";

test("arguments: only --dry-run and --help", () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, help: false });
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.throws(() => parseArgs(["--force"]), UsageError);
});

test("config: the host is required, except for a dry run", () => {
  assert.throws(() => loadConfig({}, { dryRun: false }), /DEPLOY_HOST/);
  assert.equal(loadConfig({}, { dryRun: true }).host, "root@host");
  const c = loadConfig(
    { DEPLOY_HOST: "root@vm", DEPLOY_CURL_OPTS: "-k  --http1.1", DEPLOY_SSH_OPTS: "-i key" },
    { dryRun: false },
  );
  assert.equal(c.dir, "/opt/shareinference");
  assert.equal(c.domain, "shareinference.com");
  assert.equal(c.apiDomain, "api.shareinference.com");
  assert.equal(c.platform, "linux/amd64");
  assert.deepEqual(c.curlOpts, ["-k", "--http1.1"]);
  assert.deepEqual(c.sshOpts, ["-i", "key"]);
  assert.equal(
    loadConfig({ DEPLOY_HOST: "h", DEPLOY_DOMAIN: "x.test:8443" }, { dryRun: false }).apiDomain,
    "api.x.test:8443",
  );
});

test("config: values that end up in a shell script or argv are checked", () => {
  const bad = (env) =>
    assert.throws(() => loadConfig({ DEPLOY_HOST: "root@vm", ...env }, { dryRun: false }), UsageError);
  bad({ DEPLOY_DIR: "relative/dir" });
  bad({ DEPLOY_DIR: "/opt/x; rm -rf /" });
  bad({ DEPLOY_DOMAIN: "a.com/$(id)" });
  bad({ DEPLOY_API_DOMAIN: "a b" });
  assert.throws(() => loadConfig({ DEPLOY_HOST: "-oProxyCommand=x" }, { dryRun: false }), UsageError);
});

test("tag: the short commit, dirty trees get a UTC time", () => {
  assert.equal(imageTagFor("944b268", false, new Date()), "944b268");
  assert.equal(imageTagFor("944b268", true, new Date("2026-11-20T09:05:59Z")), "944b268-dirty-202611200905");
});

test("start: the tag goes to the temp env file, the stack comes up, Caddy reloads", () => {
  const script = startScript("/opt/shareinference", "abc123");
  assert.match(script, /^cd '\/opt\/shareinference' && echo 'IMAGE_TAG=abc123' > \.deploy\.env\.new && /);
  assert.match(script, /up -d --remove-orphans/);
  assert.match(script, /caddy reload --config \/etc\/caddy\/Caddyfile/);
  assert.ok(script.endsWith(`${REMOTE_COMPOSE} ps`));
  assert.ok(script.indexOf("up -d") < script.indexOf("caddy reload"));
  // the retry loop is one `&&` operand: a failed `up -d` must stop the chain, not fall through to it
  assert.match(script, /remove-orphans && \{ ok=0;.*\[ \$ok = 1 \]; \} && /);
  // the live tag file is not touched before the health check
  assert.doesNotMatch(script, /mv |\.deploy\.env\.prev/);
});

test("promote: keeps the old tag as .deploy.env.prev, then replaces it", () => {
  const script = promoteScript("/opt/shareinference");
  assert.match(script, /cp \.deploy\.env \.deploy\.env\.prev/);
  assert.ok(script.indexOf("cp ") < script.indexOf("mv "));
  assert.match(previousTagScript("/opt/shareinference"), /\/opt\/shareinference\/\.deploy\.env/);
});

test("rollback hints: nothing started, no previous release, or the exact command", () => {
  const base = { host: "root@vm", dir: "/opt/shareinference", tag: "new1", previous: "old1" };
  assert.match(rollbackHints({ ...base, started: false })[0], /Nothing was started.*\(old1\)/);
  assert.match(rollbackHints({ ...base, previous: "", started: true })[0], /No previous release/);
  const hints = rollbackHints({ ...base, started: true });
  assert.match(hints[0], /may be running new1/);
  assert.equal(hints[1], "  IMAGE_TAG=old1 DEPLOY_HOST=root@vm pnpm run deploy");
  assert.match(hints[2], /echo IMAGE_TAG=old1 > \.deploy\.env\.new/);
});

test("help text is the header comment of the script", async () => {
  const { readFileSync } = await import("node:fs");
  const text = usage(readFileSync(new URL("./deploy.mjs", import.meta.url), "utf8"));
  assert.match(text, /DEPLOY_HOST/);
  assert.match(text, /--dry-run/);
  assert.doesNotMatch(text, /import /);
});

test(".env.prod is copied to the VM as .env, root-only", async () => {
  const { envUploadScript } = await import("./deploy.mjs");
  assert.equal(envUploadScript("/opt/shareinference"), "cd '/opt/shareinference' && cat > .env && chmod 600 .env");
});
