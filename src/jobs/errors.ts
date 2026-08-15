export function isNotReadyJobError(error: string | null | undefined): boolean {
  if (!error) return false;
  return (
    error.includes("Battle detail not ready") ||
    error.includes("Battle detail unavailable") ||
    error.includes("still has not published this battle") ||
    error.includes("below sync threshold") ||
    error.includes("circuit defers") ||
    /\bHTTP 404\b/.test(error)
  );
}
