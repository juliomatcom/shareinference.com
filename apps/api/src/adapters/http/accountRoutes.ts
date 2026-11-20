import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { createApiKey, listApiKeys, revokeApiKey } from "../../core/apiKeys.js";
import type { Deps } from "../../core/deps.js";
import type { Logger } from "../../core/ports.js";
import { updateProfile } from "../../core/users.js";
import type { User } from "../../core/types.js";
import { userOf } from "./principal.js";
import { apiError } from "./errors.js";
import { PAGE_SIZE, parsePage } from "./paging.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchMe = z
  .object({ displayName: z.string().max(100), deviceLabel: z.string().max(200).nullable() })
  .partial()
  .strict();
const createKey = z.object({ name: z.string().max(200) }).strict();

const invalid = (message: string) => apiError(400, message, "invalid_request");

const PROFILE_MESSAGES = {
  invalid_display_name: "Display name must be 3-32 characters: letters, digits, _ and -",
  display_name_taken: "That display name is not available",
  invalid_device_label: "Device label must be at most 40 printable characters",
} as const;

/** Profile, API keys and ledger of the signed-in user (session routes). */
export function accountRoutes(app: Express, opts: { core: Deps; log: Logger; requireSession: RequestHandler }): void {
  const { core, log, requireSession } = opts;

  const profile = async (user: User) => ({
    id: user.id,
    githubLogin: user.githubLogin,
    avatarUrl: user.avatarUrl,
    displayName: user.displayName,
    deviceLabel: user.deviceLabel,
    balance: (await core.ledger.balance(user.id)) ?? 0,
    createdAt: user.createdAt,
  });

  app.get("/me", requireSession, async (_req, res) => {
    res.json(await profile(userOf(res)));
  });

  app.patch("/me", requireSession, async (req, res) => {
    const body = patchMe.safeParse(req.body ?? {});
    if (!body.success || Object.keys(body.data).length === 0) {
      return res.status(400).json(invalid("Send displayName and/or deviceLabel"));
    }
    const result = await updateProfile(core, userOf(res), body.data);
    if (!result.ok) {
      return res.status(400).json(apiError(400, PROFILE_MESSAGES[result.error], result.error));
    }
    res.json(await profile(result.user));
  });

  app.get("/keys", requireSession, async (_req, res) => {
    const keys = await listApiKeys(core, userOf(res).id);
    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
      })),
    });
  });

  app.post("/keys", requireSession, async (req, res) => {
    const body = createKey.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json(invalid("Send a key name"));
    const user = userOf(res);
    const result = await createApiKey(core, user.id, body.data.name);
    if (!result.ok) {
      if (result.error === "too_many_keys") log.info("api key refused", { user_id: user.id, reason: result.error });
      return res
        .status(400)
        .json(
          result.error === "invalid_name"
            ? apiError(400, "Key name must be 1-60 printable characters", "invalid_name")
            : apiError(400, "Too many active keys: revoke one first", "too_many_keys"),
        );
    }
    const { info, key } = result;
    // Ids only: never the key itself.
    log.info("api key created", { user_id: user.id, key_id: info.id });
    // The only time the plaintext key is ever returned.
    res.status(201).json({ id: info.id, name: info.name, prefix: info.prefix, createdAt: info.createdAt, key });
  });

  app.delete("/keys/:id", requireSession, async (req, res) => {
    const id = String(req.params.id);
    const user = userOf(res);
    const revoked = UUID.test(id) && (await revokeApiKey(core, user.id, id));
    if (!revoked) return res.status(404).json(apiError(404, "Key not found", "not_found"));
    log.info("api key revoked", { user_id: user.id, key_id: id });
    res.status(204).end();
  });

  app.get("/ledger", requireSession, async (req, res) => {
    const page = parsePage(req);
    if (page === undefined)
      return res.status(400).json(apiError(400, "page must be a whole number from 1", "invalid_request"));
    const userId = userOf(res).id;
    const [entries, total] = await Promise.all([
      core.ledger.entries(userId, PAGE_SIZE, (page - 1) * PAGE_SIZE),
      core.ledger.countEntries(userId),
    ]);
    res.json({
      page,
      pageSize: PAGE_SIZE,
      total,
      entries: entries.map((e) => ({
        id: e.id,
        amount: e.amount,
        kind: e.kind,
        note: e.note,
        jobId: e.jobId,
        createdAt: e.createdAt,
      })),
    });
  });
}
