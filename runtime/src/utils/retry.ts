export async function withRetry<T>(
  action: () => Promise<T>,
  retries: number,
  backoffMs: number[],
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      const waitMs = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 500;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Retry failed");
}
