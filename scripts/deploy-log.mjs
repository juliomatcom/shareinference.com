// Progress lines for `pnpm run deploy` (scripts/deploy.mjs): one line before every step, one after with its result and
// time. Colors switch off by themselves when the output is not a terminal (chalk).
import chalk from "chalk";

/** 840 ms, 12.4 s, 3m05s. @param {number} ms */
export function fmtDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** The line before a step and the two lines it can end with. */
export const lines = {
  start: (label) => `${chalk.cyan("▸")} ${chalk.bold(label)}`,
  ok: (label, ms) => `${chalk.green("✓")} ${label} ${chalk.dim(fmtDuration(ms))}`,
  fail: (label, ms) => `${chalk.red("✗")} ${label} ${chalk.dim(fmtDuration(ms))}`,
};

/**
 * Runs one step with a line before it and a line after it. Output of the step itself shows in between; a thrown error
 * is rethrown after the red line.
 * @template T
 * @param {string} label what the step does, in plain words
 * @param {() => T | Promise<T>} run
 * @returns {Promise<T>}
 */
export async function task(label, run) {
  console.log(lines.start(label));
  const t0 = Date.now();
  try {
    const result = await run();
    console.log(lines.ok(label, Date.now() - t0));
    return result;
  } catch (error) {
    console.log(lines.fail(label, Date.now() - t0));
    throw error;
  }
}

export const heading = (text) => console.log(`\n${chalk.bold(text)}`);
export const note = (text) => console.log(chalk.dim(`  ${text}`));
export const warn = (text) => console.warn(`${chalk.yellow("!")} ${text}`);
export const success = (text) => console.log(`\n${chalk.green("✓")} ${chalk.bold(text)}`);
export const failure = (text) => console.error(`\n${chalk.red("✗")} ${text}`);
