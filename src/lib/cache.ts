/** Request-scoped memoization stub — Next.js wraps with `react` cache at the app layer when needed. */
export function cache<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}
