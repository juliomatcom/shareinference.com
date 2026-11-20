/** Starts a stopwatch; the returned function gives the milliseconds elapsed since (fractions included). */
export function startTimer(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}
