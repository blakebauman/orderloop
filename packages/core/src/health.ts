/**
 * Deep health checks: each check runs with a timeout and reports only pass or fail, so the
 * public `/health/deep` route says what is down without saying why.
 */

export type HealthStatus = 'ok' | 'fail';

export type HealthReport = {
  ok: boolean;
  service: string;
  checks: Record<string, HealthStatus>;
};

/** How long one check may take before it counts as failed. */
export const HEALTH_CHECK_TIMEOUT_MS = 3000;

export async function runHealthChecks(
  service: string,
  checks: Record<string, () => Promise<unknown>>,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<HealthReport> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, HealthStatus]> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs);
      });
      try {
        await Promise.race([check(), timeout]);
        return [name, 'ok'];
      } catch {
        return [name, 'fail'];
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const result = Object.fromEntries(entries);
  return { ok: entries.every(([, s]) => s === 'ok'), service, checks: result };
}
