import { WebSocket } from "ws";
import { loadConfig } from "./adapters/config.js";
import { devSession } from "./adapters/devSession.js";
import { createLogger } from "./adapters/logger.js";
import { createCore } from "./adapters/postgres/core.js";
import { createDb } from "./adapters/postgres/db.js";
import { outboundFrame, type OutboundFrame } from "./core/protocol.js";

// DEV/TEST ONLY: a provider that needs no browser or GPU. It signs in as the local test user <login> (the same code path
// as `users dev-session`), fetches a worker token, connects to /v1/worker with the web origin, announces the model and
// serves jobs with canned output. Run inside the api container: `pnpm fake-worker <login> [--seconds N] [--api URL]`.
// Without --seconds it stops when stdin closes (Ctrl-C on the client, or the pipe ending); with it, after N seconds.
// Never point it at a public server: anyone able to run it holds a session.
const MODEL = "Qwen3.5-4B-q4f16_1-MLC";
const GPU = { vendor: "fake", architecture: "fake-gpu", shaderF16: true, maxBufferSize: 4_294_967_296 };
const CANNED = ["Hello", " from", " the", " fake", " worker", "."];
const bootLog = createLogger("fake-worker");

function parseArgs(argv: string[]): {
  login: string;
  seconds: number | null;
  api: string | undefined;
  deviceKey: string;
} {
  const login = argv[0];
  if (!login || login.startsWith("--"))
    throw new Error("usage: fake-worker <login> [--seconds N] [--api URL] [--device KEY]");
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const seconds = flag("--seconds");
  return {
    login,
    seconds: seconds === undefined ? null : Number(seconds),
    api: flag("--api"),
    // A stable key per login, so a restarted fake worker is the same device row.
    deviceKey:
      flag("--device") ??
      `fake-${login}`
        .slice(0, 64)
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .padEnd(8, "_"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  // The api's own port (4000 in the container); pass --api to reach another one.
  const api = args.api ?? `http://127.0.0.1:${config.PORT}`;
  const log = createLogger("fake-worker", config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, 2, { log: createLogger("db", config.LOG_LEVEL) });
  let session: string;
  try {
    session = await devSession(createCore(db, config.SIGNUP_GRANT_CREDITS), args.login);
  } finally {
    await db.destroy();
  }

  const res = await fetch(`${api}/worker-token`, {
    method: "POST",
    headers: { Cookie: `si_session=${session}`, Origin: config.WEB_ORIGIN, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`worker-token failed: ${res.status}`);
  const { token } = (await res.json()) as { token: string };

  const ws = new WebSocket(`${api.replace(/^http/, "ws")}/v1/worker`, { origin: config.WEB_ORIGIN });
  const send = (frame: Record<string, unknown>) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(frame));
  let heartbeat: NodeJS.Timeout | undefined;
  let job: { id: string; cancelled: boolean } | null = null;

  async function runJob(id: string): Promise<void> {
    const current = { id, cancelled: false };
    job = current;
    // Like the real model: an (empty) think block first, raw tags included.
    const deltas = ["<think>\n\n</think>\n\n", ...CANNED];
    let sent = 0;
    for (const delta of deltas) {
      if (current.cancelled) break;
      send({ type: "chunk", id, delta });
      sent++;
      await new Promise((r) => setTimeout(r, 25));
    }
    send({
      type: "done",
      id,
      finishReason: current.cancelled ? "abort" : "stop",
      usage: { promptTokens: 12, completionTokens: sent, decodeTokensPerS: 40 },
    });
    job = null;
  }

  ws.on("open", () => {
    log.info("connected", { api });
    send({ type: "auth", token, protocol: 1, deviceKey: args.deviceKey });
  });
  ws.on("message", (data) => {
    const parsed = outboundFrame.safeParse(JSON.parse(String(data)));
    if (!parsed.success) return;
    const frame: OutboundFrame = parsed.data;
    if (frame.type === "welcome") {
      log.info("welcome", { worker_id: frame.workerId });
      send({ type: "ready", model: MODEL, gpu: GPU, loadMs: 1 });
      heartbeat = setInterval(() => send({ type: "heartbeat" }), 5_000);
    } else if (frame.type === "job") {
      if (job) send({ type: "error", id: frame.id, code: "busy", message: "a job is running" });
      else void runJob(frame.id);
    } else if (frame.type === "cancel") {
      if (job?.id === frame.id) job.cancelled = true;
    } else if (frame.type === "stats") {
      log.info("stats", { jobs_served: frame.jobsServed });
    }
  });
  ws.on("close", (code) => {
    clearInterval(heartbeat);
    log.info("closed", { code });
    process.exit(code === 1000 || code === 1005 ? 0 : 1);
  });
  ws.on("error", (error) => log.warn("socket error", { error: error.message }));

  const stop = () => {
    clearInterval(heartbeat);
    ws.close(1000);
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  if (args.seconds !== null) setTimeout(stop, args.seconds * 1_000);
  else process.stdin.on("end", stop).resume();
}

main().catch((error) => {
  bootLog.error("fake worker failed", { error: String(error.message ?? error) });
  process.exit(1);
});
