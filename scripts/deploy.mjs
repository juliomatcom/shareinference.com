#!/usr/bin/env node
// Deploy to the production VM without building there (D41): build both images here, stream them over ssh, copy the
// compose files and Caddy config, start the stack, check health. Runbook: docs/deploy.md.
//
//   DEPLOY_HOST=root@host pnpm run deploy [--dry-run]
//   IMAGE_TAG=<tag on the VM> DEPLOY_HOST=root@host pnpm run deploy      # redeploy / roll back: no build, no upload
// (plain `pnpm deploy` is pnpm's own command.)
//
// Environment:
//   DEPLOY_HOST       ssh target, root@host (required; never committed). The VM is operated as root, key-only ssh.
//   DEPLOY_DIR        directory on the VM (default /opt/shareinference); holds the hand-made .env (secrets)
//   DEPLOY_DOMAIN     public host[:port] used for the health check (default shareinference.com)
//   DEPLOY_API_DOMAIN api host[:port] for the health check (default api.<DEPLOY_DOMAIN>)
//   DEPLOY_CURL_OPTS  extra curl options for the health check (e.g. "-k" against a local test certificate)
//   DEPLOY_PLATFORM   image platform of the VM (default linux/amd64; building it on an ARM machine needs qemu emulation,
//                     which is slow: build on an amd64 machine or in CI when you can)
//   DEPLOY_SSH_OPTS   extra ssh options (e.g. "-i ~/.ssh/key")
//   IMAGE_TAG         default: short git commit, plus -dirty-<time> for an uncommitted tree. Setting it means the images
//                     already exist on the VM (a rollback): nothing is built or sent.
// --dry-run builds the images (unless IMAGE_TAG is set) but only prints what it would run on the VM.
//
// .env.prod (gitignored), when it exists, is uploaded as the VM's .env together with the images (not on a rollback).
//
// .deploy.env on the VM (the live tag) is replaced only after the new stack is up and healthy; the old one is kept as
// .deploy.env.prev. On any failure the exact rollback command is printed.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { failure, fmtDuration, heading, note, success, task, warn } from "./deploy-log.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Uploaded as the VM's .env with the images when it exists (gitignored). */
const ENV_FILE = ".env.prod";
export const envUploadScript = (dir) => `cd '${dir}' && cat > .env && chmod 600 .env`;
const SAFE_TAG = /^[A-Za-z0-9_.-]+$/;
const SAFE_HOST = /^[A-Za-z0-9.:-]+$/;
const SAFE_DIR = /^\/[A-Za-z0-9_./-]+$/;
const HEALTH_TRIES = 30;
const HEALTH_PAUSE_MS = 3000;

/** Errors already shown to the user (with the rollback hints): the last handler stays quiet about them. */
const reported = new WeakSet();

/** A wrong flag or setting: reported plainly, exit code 2. */
export class UsageError extends Error {}

/** @param {string[]} argv @returns {{dryRun: boolean, help: boolean}} */
export function parseArgs(argv) {
  const opts = { dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === "--") continue; // pnpm forwards the separator of `pnpm run deploy -- --dry-run`
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new UsageError(`unknown argument: ${arg} (try --dry-run)`);
  }
  return opts;
}

/** The comment block at the top of this file, as help text. */
export function usage(source) {
  return source
    .split("\n")
    .slice(1, 24)
    .filter((l) => l.startsWith("//"))
    .map((l) => l.replace(/^\/\/ ?/, ""))
    .join("\n");
}

/**
 * Settings from the environment, validated: they all end up inside a shell script on the VM or in argv.
 * @param {Record<string, string | undefined>} env
 * @param {{dryRun: boolean}} opts
 */
export function loadConfig(env, { dryRun }) {
  const host = env.DEPLOY_HOST || (dryRun ? "root@host" : "");
  if (!host) throw new UsageError("set DEPLOY_HOST (root@host of the VM)");
  if (host.startsWith("-") || /\s/.test(host)) throw new UsageError(`invalid DEPLOY_HOST: ${host}`);
  const dir = env.DEPLOY_DIR || "/opt/shareinference";
  const domain = env.DEPLOY_DOMAIN || "shareinference.com";
  const apiDomain = env.DEPLOY_API_DOMAIN || `api.${domain}`;
  if (!SAFE_DIR.test(dir)) throw new UsageError("DEPLOY_DIR must be an absolute path of plain characters");
  if (!SAFE_HOST.test(domain) || !SAFE_HOST.test(apiDomain)) {
    throw new UsageError("DEPLOY_DOMAIN and DEPLOY_API_DOMAIN must be host names");
  }
  const split = (value) => (value ?? "").split(/\s+/).filter(Boolean);
  return {
    host,
    dir,
    domain,
    apiDomain,
    platform: env.DEPLOY_PLATFORM || "linux/amd64",
    curlOpts: split(env.DEPLOY_CURL_OPTS),
    sshOpts: split(env.DEPLOY_SSH_OPTS),
    imageTag: env.IMAGE_TAG || "",
  };
}

/**
 * The tag of the images: the short commit, with -dirty-<UTC time> for an uncommitted tree.
 * @param {string} sha @param {boolean} dirty @param {Date} now
 */
export function imageTagFor(sha, dirty, now) {
  if (!dirty) return sha;
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 12);
  return `${sha}-dirty-${stamp}`;
}

/** The compose command on the VM. The new tag goes through a temp env file; .deploy.env changes only once healthy. */
export const REMOTE_COMPOSE =
  "docker compose -f compose.yaml -f compose.prod.yaml --env-file .env --env-file .deploy.env.new";

/** `caddy reload` applies a changed Caddyfile (the ops/caddy directory is mounted; a recreated container reads it anyway). */
export const RELOAD_CADDY = `{ ok=0; for i in 1 2 3 4 5 6; do if ${REMOTE_COMPOSE} exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then ok=1; break; fi; sleep 2; done; [ $ok = 1 ]; }`;

/** The tag that is live on the VM now (the rollback target); empty when there is none. */
export const previousTagScript = (dir) => `sed -n 's/^IMAGE_TAG=//p' '${dir}/.deploy.env' 2>/dev/null || true`;

/** Start the new tag: written to the temp env file, the stack up, Caddy reloaded. */
export const startScript = (dir, tag) =>
  `cd '${dir}' && echo 'IMAGE_TAG=${tag}' > .deploy.env.new && ${REMOTE_COMPOSE} up -d --remove-orphans && ${RELOAD_CADDY} && ${REMOTE_COMPOSE} ps`;

/** Healthy: the new tag becomes the live one, the old one is kept for rollback. */
export const promoteScript = (dir) =>
  `cd '${dir}' && { [ ! -f .deploy.env ] || cp .deploy.env .deploy.env.prev; } && mv .deploy.env.new .deploy.env`;

/**
 * What to print after a failure: the state of the VM and how to go back.
 * @param {{host: string, dir: string, tag: string, previous: string, started: boolean}} s
 */
export function rollbackHints({ host, dir, tag, previous, started }) {
  if (!started) {
    return [`Nothing was started; the running release${previous ? ` (${previous})` : ""} is unchanged.`];
  }
  if (!previous) {
    return [`No previous release is recorded; inspect with '${REMOTE_COMPOSE} logs --tail 100' in ${dir}.`];
  }
  return [
    `The stack may be running ${tag}. Roll back to the previous release with either:`,
    `  IMAGE_TAG=${previous} DEPLOY_HOST=${host} pnpm run deploy`,
    `  (on the VM, in ${dir})  echo IMAGE_TAG=${previous} > .deploy.env.new && ${REMOTE_COMPOSE} up -d`,
  ];
}

// One ssh connection for every step. The socket lives in the temp directory (a unix socket path must stay short);
// `closeConnection` ends it when the deploy is over.
const controlPath = join(tmpdir(), "shareinference-deploy-%C");
const mux = ["-o", "ControlMaster=auto", "-o", `ControlPath=${controlPath}`, "-o", "ControlPersist=5m"];

/** Spawned processes learn the target from here (main sets it once). @type {ReturnType<typeof loadConfig> | null} */
let cfg = null;
const sshArgs = (...rest) => [...mux, ...cfg.sshOpts, ...rest];
const closeConnection = () => void (cfg && spawnSync("ssh", sshArgs("-O", "exit", cfg.host), { stdio: "ignore" }));

/** Run a command here, output on the terminal; a failure throws. @param {string} cmd @param {string[]} args */
function local(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: REPO_ROOT, env: { ...process.env, ...env } });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed (exit ${res.status ?? res.signal})`);
}

/** Run a shell script on the VM. With `capture` its stdout is returned instead of shown. */
function remote(script, { capture = false, tolerate = false } = {}) {
  const res = spawnSync("ssh", sshArgs(cfg.host, script), {
    stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"],
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !tolerate) throw new Error(`ssh step failed (exit ${res.status ?? res.signal})`);
  return { ok: res.status === 0, out: res.stdout ?? "" };
}

const exited = (child, name) =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${name} failed (exit ${code ?? signal})`)),
    );
  });

/**
 * `from | [gzip |] to`, as processes: no shell, so nothing needs quoting.
 * @param {[string, string[], Record<string, string>?]} from @param {[string, string[]]} to @param {boolean} gzip
 */
async function pipe(from, to, gzip = false) {
  const producer = spawn(from[0], from[1], {
    stdio: ["ignore", "pipe", "inherit"],
    cwd: REPO_ROOT,
    env: { ...process.env, ...from[2] },
  });
  const consumer = spawn(to[0], to[1], { stdio: ["pipe", "inherit", "inherit"] });
  const stages = gzip ? [producer.stdout, createGzip(), consumer.stdin] : [producer.stdout, consumer.stdin];
  try {
    await Promise.all([pipeline(...stages), exited(producer, from[0]), exited(consumer, to[0])]);
  } catch (error) {
    producer.kill();
    consumer.kill();
    throw error;
  }
}

function git(...args) {
  const res = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/** Both public health URLs answer 2xx. */
function healthy({ domain, apiDomain, curlOpts }) {
  const probe = (url) =>
    spawnSync("curl", ["-fsS", "--max-time", "10", ...curlOpts, url], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  const web = probe(`https://${domain}/api/healthz`);
  if (web.status !== 0) return null;
  const api = probe(`https://${apiDomain}/healthz`);
  return api.status === 0 ? api.stdout.trim() : null;
}

async function waitHealthy(c) {
  for (let i = 0; i < HEALTH_TRIES; i++) {
    const body = healthy(c);
    if (body !== null) return body;
    await sleep(HEALTH_PAUSE_MS);
  }
  throw new Error(`health check failed: run '${REMOTE_COMPOSE} logs --tail 100' in ${c.dir} on the VM`);
}

/** The commands a real run would execute on the VM, for --dry-run. */
function printPlan(c, tag, redeploy) {
  console.log("== commands");
  const show = (cmd) => console.log(`+ ${cmd}`);
  if (!redeploy) {
    show(
      `docker save shareinference-api:${tag} shareinference-web:${tag} | gzip | ssh ${c.host} 'gunzip | docker load'`,
    );
  }
  show(`tar -cf - compose.yaml compose.prod.yaml ops | ssh ${c.host} 'mkdir -p ${c.dir} && tar -xf - -C ${c.dir}'`);
  if (!redeploy && existsSync(join(REPO_ROOT, ENV_FILE))) {
    show(`cat ${ENV_FILE} | ssh ${c.host} '${envUploadScript(c.dir)}'`);
  }
  show(`ssh ${c.host} '${startScript(c.dir, tag)}'`);
  show(`curl --fail https://${c.domain}/api/healthz && curl --fail https://${c.apiDomain}/healthz`);
  show(`ssh ${c.host} '${promoteScript(c.dir)}'`);
  console.log("dry run: nothing was sent");
}

async function main(argv, env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    const { readFileSync } = await import("node:fs");
    console.log(usage(readFileSync(fileURLToPath(import.meta.url), "utf8")));
    return;
  }
  const c = (cfg = loadConfig(env, opts));
  const redeploy = c.imageTag !== "";
  const tag = redeploy
    ? c.imageTag
    : imageTagFor(git("rev-parse", "--short", "HEAD"), git("status", "--porcelain") !== "", new Date());
  if (!SAFE_TAG.test(tag)) throw new UsageError(`invalid IMAGE_TAG: ${tag}`);

  const started = Date.now();
  heading(`Deploying ${tag} (${c.platform}) to ${c.host}:${c.dir}`);

  // Before anything changes: what is live now (the rollback target). Remote data: only a plain tag is trusted.
  let previous = "";
  if (!opts.dryRun) {
    const out = await task("Read the live release", () =>
      remote(previousTagScript(c.dir), { capture: true }).out.trim(),
    );
    previous = SAFE_TAG.test(out) ? out : "";
  }
  let began = false;
  try {
    if (!redeploy) {
      // Only the base compose file knows the build contexts; the build needs no secrets (a placeholder DATABASE_URL
      // satisfies compose's required-variable check on a machine without a .env).
      await task("Build the images", () =>
        local("docker", ["compose", "-f", "compose.yaml", "build", "api", "web"], {
          DATABASE_URL: env.DATABASE_URL || "unused",
          DOCKER_DEFAULT_PLATFORM: c.platform,
          IMAGE_TAG: tag,
        }),
      );
    }
    if (opts.dryRun) return printPlan(c, tag, redeploy);

    // Without a local .env.prod the VM needs its hand-made secrets file already.
    const sendEnv = !redeploy && existsSync(join(REPO_ROOT, ENV_FILE));
    await task("Check the VM", () => {
      if (!sendEnv && !remote(`test -f '${c.dir}/.env'`, { tolerate: true }).ok) {
        throw new Error(`${c.dir}/.env is missing on the VM: create it first (docs/deploy.md, step 'Production .env')`);
      }
      if (redeploy) {
        for (const image of ["api", "web"]) {
          const found = remote(`docker image inspect shareinference-${image}:${tag} >/dev/null`, { tolerate: true });
          if (!found.ok) {
            throw new Error(
              `shareinference-${image}:${tag} is not on the VM; deploy it without IMAGE_TAG to build and send it`,
            );
          }
        }
      }
    });

    if (!redeploy) {
      await task("Ship the images", () =>
        pipe(
          ["docker", ["save", `shareinference-api:${tag}`, `shareinference-web:${tag}`]],
          ["ssh", sshArgs(c.host, "gunzip | docker load")],
          true,
        ),
      );
    }
    await task("Ship the compose files", () =>
      pipe(
        ["tar", ["-cf", "-", "compose.yaml", "compose.prod.yaml", "ops"]],
        ["ssh", sshArgs(c.host, `mkdir -p '${c.dir}' && tar -xf - -C '${c.dir}'`)],
      ),
    );

    if (sendEnv) {
      await task(`Ship ${ENV_FILE} as the VM's .env`, () =>
        pipe(["cat", [ENV_FILE]], ["ssh", sshArgs(c.host, envUploadScript(c.dir))]),
      );
    }

    began = true;
    await task("Start the stack", () => remote(startScript(c.dir, tag)));
    const body = await task("Wait for the health checks", () => waitHealthy(c));
    if (body) note(body);

    // Healthy: this tag is now the live one; keep the old one for rollback.
    await task("Make it the live release", () => remote(promoteScript(c.dir)));
  } catch (error) {
    failure(`DEPLOY FAILED: ${error instanceof Error ? error.message : String(error)}`);
    reported.add(error);
    for (const line of rollbackHints({ host: c.host, dir: c.dir, tag, previous, started: began })) warn(line);
    throw error;
  }
  success(
    `Deployed ${tag} in ${fmtDuration(Date.now() - started)}` +
      (previous ? ` (previous: ${previous}; roll back with IMAGE_TAG=${previous} pnpm run deploy)` : ""),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env)
    .catch((error) => {
      if (!reported.has(error)) failure(error instanceof Error ? error.message : String(error));
      process.exitCode = error instanceof UsageError ? 2 : 1;
    })
    .finally(closeConnection);
}
