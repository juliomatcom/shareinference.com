import type { Deps } from "./deps.js";
import type { ApiKeyInfo } from "./types.js";
import { KEY_NAME_MAX, printableText } from "./validation.js";

export const MAX_ACTIVE_KEYS = 20;
const PREFIX_LENGTH = "si_".length + 8;

export type CreateKeyResult =
  { ok: true; info: ApiKeyInfo; key: string } | { ok: false; error: "invalid_name" | "too_many_keys" };

/** `si_` + 32 random bytes. The plaintext is returned once; the store keeps its SHA-256 and a display prefix. */
export async function createApiKey(deps: Deps, userId: string, name: string): Promise<CreateKeyResult> {
  const clean = printableText(name, KEY_NAME_MAX);
  if (clean === undefined) return { ok: false, error: "invalid_name" };
  const key = `si_${deps.secrets.token()}`;
  const info = await deps.apiKeys.create(
    { userId, name: clean, prefix: key.slice(0, PREFIX_LENGTH), keyHash: deps.secrets.hash(key) },
    MAX_ACTIVE_KEYS,
  );
  if (!info) return { ok: false, error: "too_many_keys" };
  return { ok: true, info, key };
}

export const listApiKeys = (deps: Deps, userId: string): Promise<ApiKeyInfo[]> => deps.apiKeys.listByUser(userId);

/** True when the user's own live key was revoked. */
export const revokeApiKey = (deps: Deps, userId: string, id: string): Promise<boolean> =>
  deps.apiKeys.revoke(id, userId, deps.clock.now());
