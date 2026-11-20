import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Deps } from "../../core/deps.js";
import { IP_LIMITS, createIpLimiter } from "../../core/ipLimiter.js";
import type { Logger } from "../../core/ports.js";
import { CLOSE, MAX_FRAME_BYTES, inboundFrame, type InboundFrame, type OutboundFrame } from "../../core/protocol.js";
import { clientIp } from "../http/clientIp.js";
import { authenticateWorker, workerHeartbeat, workerReady } from "../../core/workers.js";

export const WORKER_PATH = "/v1/worker";

export interface WorkerServerOptions {
  server: HttpServer;
  core: Deps;
  log: Logger;
  /** The upgrade's Origin header must equal this (a browser tab of our own web app). */
  webOrigin: string;
  /** First frame (`auth`) deadline, default 5 s. */
  authTimeoutMs?: number;
  /** `ready` deadline after a successful auth. */
  readyTimeoutMs?: number;
  /** How often silent workers are swept. */
  sweepEveryMs?: number;
  /** Open sockets in total, authenticated or not. */
  maxConnections?: number;
  /** Sockets that have not authenticated yet (default 300): bounds what an anonymous peer can hold open. */
  maxUnauthenticated?: number;
  /** Per-IP upgrades read `X-Real-IP` (set by the reverse proxy) instead of the socket address. Default false. */
  trustProxy?: boolean;
  /** Upgrades per IP per minute (default `IP_LIMITS.upgradePerMin`); over it the upgrade is refused with 429. */
  upgradesPerMin?: number;
}

/** Bytes of received-but-unprocessed frames per socket; past this the peer is outrunning us (retryable, 4413). */
const MAX_QUEUED_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 2_000;

const frameBytes = (data: RawData): number =>
  Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength;

function refuseUpgrade(socket: Duplex, status: string): void {
  socket.on("error", () => {});
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Provider WebSocket (`GET /v1/worker`, wiki-llm/worker-protocol.md) attached to the api's HTTP server. */
export function attachWorkerServer(opts: WorkerServerOptions): { close(): void } {
  const { server, core, log, webOrigin } = opts;
  const authTimeoutMs = opts.authTimeoutMs ?? 5_000;
  const maxUnauthenticated = opts.maxUnauthenticated ?? 300;
  let unauthenticated = 0;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  const maxConnections = opts.maxConnections ?? 10_000;

  const upgrades = createIpLimiter(core, opts.upgradesPerMin ?? IP_LIMITS.upgradePerMin);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /** The open socket of each authenticated worker. */
  const sockets = new Map<string, WebSocket>();

  const drop = (ws: WebSocket, code: number) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
    ws.close(code);
    // A peer that never answers the close frame must not hold the socket.
    setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
  };

  // The dispatcher reaches workers through this (it is created before any socket exists).
  core.dispatcher.setLink({
    send(workerId, frame) {
      const ws = sockets.get(workerId);
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },
    drop(workerId, code) {
      const ws = sockets.get(workerId);
      if (!ws) return;
      sockets.delete(workerId);
      core.registry.unregister(workerId);
      log.info("worker dropped", { worker_id: workerId, code });
      drop(ws, code);
    },
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" || path !== WORKER_PATH) return refuseUpgrade(socket, "404 Not Found");
    if (!upgrades.hit(clientIp(req, opts.trustProxy ?? false))) {
      log.warn("worker upgrade refused", { reason: "rate_limited" });
      return refuseUpgrade(socket, "429 Too Many Requests");
    }
    if (req.headers.origin !== webOrigin) {
      log.warn("worker upgrade refused", { reason: "origin" });
      return refuseUpgrade(socket, "403 Forbidden");
    }
    if (wss.clients.size >= maxConnections || unauthenticated >= maxUnauthenticated) {
      return refuseUpgrade(socket, "503 Service Unavailable");
    }
    wss.handleUpgrade(req, socket, head, (ws) => connection(ws));
  };

  function connection(ws: WebSocket): void {
    let phase: "auth" | "authed" = "auth";
    let workerId: string | null = null;
    let closed = false;
    let queuedBytes = 0;
    // Counted against the pre-auth budget until it authenticates or closes, whichever comes first.
    let counted = true;
    unauthenticated++;
    const settle = () => {
      if (counted) unauthenticated--;
      counted = false;
    };
    let queue: Promise<void> = Promise.resolve();
    let readyTimer: NodeJS.Timeout | undefined;

    const send = (frame: OutboundFrame) => ws.send(JSON.stringify(frame));
    const authTimer = setTimeout(() => drop(ws, CLOSE.unauthorized), authTimeoutMs);

    ws.on("error", (error) => log.debug("worker socket error", { error: String(error.message) }));
    ws.on("close", (code) => {
      closed = true;
      settle();
      clearTimeout(authTimer);
      clearTimeout(readyTimer);
      // A device that reconnected owns the entry now; only the current socket unregisters.
      if (workerId && sockets.get(workerId) === ws) {
        sockets.delete(workerId);
        core.registry.unregister(workerId);
        core.dispatcher.onWorkerGone(workerId);
        log.info("worker disconnected", { worker_id: workerId, code });
      }
    });

    async function handle(frame: InboundFrame): Promise<void> {
      if (phase === "auth") {
        if (frame.type !== "auth") return drop(ws, CLOSE.badFrame);
        const result = await authenticateWorker(core, frame, () => !closed);
        clearTimeout(authTimer);
        if (!result.ok) {
          log.warn("worker refused", { close: result.close });
          return drop(ws, result.close);
        }
        // No `closed` check here: authenticateWorker registered only after its own liveness check, and nothing awaits
        // between that and this line.
        const previous = sockets.get(result.workerId);
        sockets.set(result.workerId, ws);
        if (previous && previous !== ws) {
          drop(previous, CLOSE.replaced);
          // Whatever the replaced socket was serving is lost: its job follows the failure rules.
          core.dispatcher.onWorkerGone(result.workerId);
        }
        workerId = result.workerId;
        phase = "authed";
        settle();
        readyTimer = setTimeout(() => drop(ws, CLOSE.timeout), readyTimeoutMs);
        log.info("worker connected", { worker_id: workerId, user_id: result.userId, replaced: result.replaced });
        return send({ type: "welcome", workerId });
      }
      // A socket that was replaced by a newer connection of its device no longer speaks for the worker.
      if (sockets.get(workerId!) !== ws) return;
      switch (frame.type) {
        case "ready": {
          const result = await workerReady(core, workerId!, frame, () => sockets.get(workerId!) === ws);
          if (!result.ok) return drop(ws, result.close);
          clearTimeout(readyTimer);
          log.info("worker ready", { worker_id: workerId, model: frame.model, load_ms: frame.loadMs });
          core.dispatcher.onWorkerReady(workerId!);
          return;
        }
        case "heartbeat": {
          if ((await workerHeartbeat(core, workerId!)) === "suspended" && sockets.get(workerId!) === ws) {
            log.info("worker owner suspended", { worker_id: workerId });
            sockets.delete(workerId!);
            core.registry.unregister(workerId!);
            core.dispatcher.onWorkerGone(workerId!);
            drop(ws, CLOSE.suspended);
          }
          return;
        }
        // Frames for an unknown or finished job id are ignored by the dispatcher (worker-protocol.md).
        case "chunk":
          return core.dispatcher.onChunk(workerId!, frame);
        case "done":
          return core.dispatcher.onDone(workerId!, frame);
        case "error":
          return core.dispatcher.onError(workerId!, frame);
        case "auth":
          return drop(ws, CLOSE.badFrame);
      }
    }

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return drop(ws, CLOSE.badFrame);
      // Never log the frame: it may carry completion text.
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return drop(ws, CLOSE.badFrame);
      }
      const parsed = inboundFrame.safeParse(json);
      if (!parsed.success) return drop(ws, CLOSE.badFrame);
      const size = frameBytes(data);
      if (queuedBytes + size > MAX_QUEUED_BYTES) return drop(ws, CLOSE.backlog);
      queuedBytes += size;
      // One frame at a time per socket: auth and ready await the database.
      queue = queue
        .then(() => handle(parsed.data))
        .catch((error) => {
          log.error("worker frame failed", { error });
          drop(ws, 1011);
        })
        .finally(() => (queuedBytes -= size));
    });
  }

  server.on("upgrade", onUpgrade);
  const sweeper = setInterval(() => {
    for (const w of core.registry.sweep()) {
      log.info("worker timed out", { worker_id: w.id });
      const ws = sockets.get(w.id);
      sockets.delete(w.id);
      core.dispatcher.onWorkerGone(w.id);
      if (ws) drop(ws, CLOSE.timeout);
    }
  }, opts.sweepEveryMs ?? 5_000);
  sweeper.unref();

  return {
    close() {
      clearInterval(sweeper);
      server.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
