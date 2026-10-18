/**
 * An `Env` for the evals: just what ai.ts reads, with `AI.run` calling Workers AI over the REST
 * API (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN) instead of a binding. The models are
 * wrangler.jsonc's, so an eval run tests the models production uses, or the ones a change sets.
 * Not through the AI Gateway: evals must not spend production's rate limit.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';

const vars = (
  parse(readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8')) as {
    vars: Record<string, string>;
  }
).vars;

export const credentials = {
  account: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
  token: process.env.CLOUDFLARE_API_TOKEN ?? '',
};

export const hasCredentials = !!(credentials.account && credentials.token);

export function liveEnv(): Env {
  const ai = {
    async run(model: string, inputs: unknown) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${credentials.account}/ai/run/${model}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credentials.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(inputs),
        },
      );
      const body = (await res.json()) as { success: boolean; result?: unknown; errors?: unknown };
      if (!res.ok || !body.success)
        throw new Error(`Workers AI ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
      return body.result;
    },
  };
  return {
    ...vars,
    AI_MODE: 'live',
    AI_GATEWAY_ID: '',
    AI_PERSONAL_DATA: 'redact',
    AI: ai,
  } as unknown as Env;
}
