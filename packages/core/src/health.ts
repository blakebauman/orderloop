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

/**
 * The deploy smoke test's write check, on the web app: a round trip through every store each
 * Worker writes to, each leaving nothing behind. Not public: it takes a header CI signs
 * (`signHealthCheck`), since unlike a read, anyone calling it would cost writes.
 */
export const HEALTH_WRITE_PATH = '/health/write';

/**
 * What another Worker reported, as checks of this one's named `<prefix>.<check>`, so a failure
 * still names the store. A report that never arrives (the call threw, or outlasted `timeoutMs`)
 * is a single failed `<prefix>`.
 */
export async function remoteChecks(
  prefix: string,
  call: () => Promise<HealthReport>,
  timeoutMs = 2 * HEALTH_CHECK_TIMEOUT_MS,
): Promise<Record<string, HealthStatus>> {
  let report: HealthReport | undefined;
  const reached = await runHealthChecks(
    prefix,
    {
      [prefix]: async () => {
        report = await call();
      },
    },
    timeoutMs,
  );
  const checks = report?.checks;
  if (!reached.ok || !checks || typeof checks !== 'object' || !Object.keys(checks).length)
    return { [prefix]: 'fail' };
  return Object.fromEntries(
    Object.entries(checks).map(([name, s]) => [`${prefix}.${name}`, s === 'ok' ? 'ok' : 'fail']),
  );
}

/** One report from checks run here and in other Workers (`remoteChecks`). */
export function healthReport(
  service: string,
  ...parts: Record<string, HealthStatus>[]
): HealthReport {
  const checks = Object.assign({}, ...parts) as Record<string, HealthStatus>;
  return { ok: Object.values(checks).every((s) => s === 'ok'), service, checks };
}
