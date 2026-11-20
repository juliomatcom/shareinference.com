/** Display name: 3-32 chars of letters, digits, `_` and `-`. */
export const DISPLAY_NAME_RE = /^[A-Za-z0-9_-]{3,32}$/;
export const DEVICE_LABEL_MAX = 40;
export const KEY_NAME_MAX = 60;

export const isDisplayName = (value: string): boolean => DISPLAY_NAME_RE.test(value);

/** Names nobody may take: they read as the service or its staff (compared case-insensitively). */
const RESERVED_NAMES = new Set([
  "admin",
  "administrator",
  "root",
  "system",
  "support",
  "help",
  "security",
  "api",
  "shareinference",
  "moderator",
  "mod",
  "staff",
  "official",
  "null",
  "undefined",
]);

export const isReservedName = (name: string): boolean => RESERVED_NAMES.has(name.toLowerCase());

// No control, format, line or paragraph separator characters (they would break tables, logs and the leaderboard),
// and none of the code points that render as blank (Hangul fillers, Braille blank).
const FORBIDDEN = /[\p{C}\p{Zl}\p{Zp}\u3164\u2800\u115F\u1160\uFFA0]/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// Zalgo: stacks of combining marks.
const MARK_RUN = /\p{M}{3,}/u;

/**
 * A trimmed, printable text of at most `max` characters that shows something (a letter or digit) and has no stack of
 * combining marks; undefined when it is not.
 */
export function printableText(value: string, max: number): string | undefined {
  const text = value.trim();
  if (text === "" || [...text].length > max) return undefined;
  if (FORBIDDEN.test(text) || !HAS_LETTER_OR_DIGIT.test(text) || MARK_RUN.test(text)) return undefined;
  return text;
}

/** Device label: optional, so empty clears it (`null`); undefined when invalid. */
export function deviceLabel(value: string | null): string | null | undefined {
  if (value === null || value.trim() === "") return null;
  return printableText(value, DEVICE_LABEL_MAX);
}
