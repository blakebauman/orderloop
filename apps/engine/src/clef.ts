/**
 * Assessments on Workers AI Clef: a multimodal decision model that reads a state (text or JSON,
 * plus up to 4 images) and answers typed questions with a probability for every allowed option.
 * Like every AI call here it has a deterministic heuristic fallback, used when AI_MODE is "mock"
 * or the model errors, and answers are held to the questions asked (`clampAnswers`).
 *
 * Clef takes only embedded images, so references (R2 keys, https or data URLs) are resolved here,
 * inside the caller's step. R2 keys are limited to the order's own documents.
 */

import {
  type AiProvenance,
  type AssessAnswers,
  type AssessQuestions,
  clampAnswers,
  promptId,
  safeFetch,
} from '@orderloop/core';
import { logAiCall, withTimeout } from './ai';

/** Clef's limits: 4 images, 4 MiB each, 8 MiB decoded in all. */
export const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AI_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 10_000;

export type ClefImage = { content_type: string; base64: string };
export type Assessment = {
  answers: AssessAnswers;
  usage?: { input_tokens: number; output_tokens: number };
};

// ── Images ─────────────────────────────────────────────────────────────────

const mime = (v: string | null | undefined) => (v ?? '').split(';')[0]!.trim().toLowerCase();

/** Reads at most `cap` bytes; null when the body is larger. */
async function readCapped(body: ReadableStream<Uint8Array>, cap: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function loadImage(
  env: Env,
  ref: string,
  orderId: string,
): Promise<{ type: string; bytes: Uint8Array } | string> {
  const short = ref.length > 60 ? `${ref.slice(0, 57)}…` : ref;
  if (/^data:/i.test(ref)) {
    const m = /^data:([^;,]+);base64,(.*)$/is.exec(ref);
    if (!m) return `${short}: not a base64 data URL`;
    if (m[2]!.length * 0.75 > MAX_IMAGE_BYTES) return `${short}: over 4 MiB`;
    return { type: mime(m[1]), bytes: Buffer.from(m[2]!, 'base64') };
  }
  if (/^https:\/\//i.test(ref)) {
    // Behind the egress policy, a few redirects allowed (images often sit behind a CDN's), each
    // checked again; nothing credentialed is sent.
    let res: Response;
    try {
      res = await safeFetch(ref, { timeoutMs: FETCH_TIMEOUT_MS, redirects: 3 });
    } catch (err) {
      return `${short}: ${err instanceof Error ? err.message : 'unreachable'}`;
    }
    if (!res.ok || !res.body) return `${short}: HTTP ${res.status}`;
    const type = mime(res.headers.get('content-type'));
    if (!IMAGE_TYPES.has(type)) {
      await res.body.cancel();
      return `${short}: ${type || 'unknown type'} is not PNG, JPEG or WebP`;
    }
    const bytes = await readCapped(res.body, MAX_IMAGE_BYTES);
    return bytes ? { type, bytes } : `${short}: over 4 MiB`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return `${short}: only https, data URLs or R2 keys`;
  if (!ref.startsWith(`orders/${orderId}/`)) return `${short}: not one of this order's documents`;
  const obj = await env.DOCS.get(ref);
  if (!obj) return `${short}: no such document`;
  const type = mime(obj.httpMetadata?.contentType);
  if (obj.size > MAX_IMAGE_BYTES) {
    await obj.body.cancel();
    return `${short}: over 4 MiB`;
  }
  return { type, bytes: new Uint8Array(await obj.arrayBuffer()) };
}

/**
 * Embeds up to 4 images for Clef. Anything unusable (wrong type, too big, another order's
 * document, unreachable) is skipped with a note rather than failing the assessment.
 */
export async function resolveImages(
  env: Env,
  refs: string[],
  orderId: string,
): Promise<{ images: ClefImage[]; notes: string[] }> {
  const images: ClefImage[] = [];
  const notes: string[] = [];
  let total = 0;
  for (const ref of refs.map((r) => r.trim()).filter(Boolean)) {
    if (images.length === MAX_IMAGES) {
      notes.push(`Only the first ${MAX_IMAGES} images are used`);
      break;
    }
    const got = await loadImage(env, ref, orderId).catch(
      (err: unknown) => `${ref.slice(0, 60)}: ${err instanceof Error ? err.message : 'failed'}`,
    );
    if (typeof got === 'string') {
      notes.push(got);
      continue;
    }
    if (!IMAGE_TYPES.has(got.type)) {
      notes.push(`${ref.slice(0, 60)}: ${got.type || 'unknown type'} is not PNG, JPEG or WebP`);
      continue;
    }
    if (got.bytes.byteLength > MAX_IMAGE_BYTES || total + got.bytes.byteLength > MAX_TOTAL_BYTES) {
      notes.push(`${ref.slice(0, 60)}: over the image size limit`);
      continue;
    }
    total += got.bytes.byteLength;
    images.push({ content_type: got.type, base64: Buffer.from(got.bytes).toString('base64') });
  }
  return { images, notes };
}

// ── Heuristic ──────────────────────────────────────────────────────────────

const words = (v: unknown) =>
  new Set(
    (typeof v === 'string' ? v : JSON.stringify(v ?? ''))
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );

/**
 * Without the model: yes/no is a coin flip, a score sits mid-rubric, and a choice leans toward
 * the option whose id and description share the most words with the state. Deterministic.
 */
export function assessHeuristic(questions: AssessQuestions, state: unknown): AssessAnswers {
  const seen = words(state);
  const raw: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type !== 'choice') continue;
    const weight = Object.entries(q.criteria).map(([opt, desc]) => {
      let hits = 0;
      for (const w of words(`${opt.replace(/_/g, ' ')} ${JSON.stringify(desc ?? '')}`))
        if (seen.has(w)) hits++;
      return [opt, 1 + hits] as const;
    });
    const sum = weight.reduce((a, [, w]) => a + w, 0);
    raw[id] = { probabilities: Object.fromEntries(weight.map(([o, w]) => [o, w / sum])) };
  }
  return clampAnswers(questions, raw);
}

// ── Model ──────────────────────────────────────────────────────────────────

export async function assess(
  env: Env,
  input: { state: unknown; questions: AssessQuestions; images?: ClefImage[] },
): Promise<{ value: Assessment } & AiProvenance> {
  const prompt = promptId('assess');
  const started = Date.now();
  const heuristic = (reason: string) => {
    const p: AiProvenance = { source: 'heuristic', model: null, prompt, fallback: reason };
    logAiCall(p, Date.now() - started);
    return { value: { answers: assessHeuristic(input.questions, input.state) }, ...p };
  };
  if (String(env.AI_MODE) === 'mock') return heuristic('mock');
  try {
    const res = (await withTimeout(
      env.AI.run(
        env.ASSESS_MODEL as never,
        {
          model: 'clef',
          state: input.state,
          questions: input.questions,
          ...(input.images?.length ? { images: input.images } : {}),
        } as never,
        env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined,
      ),
      AI_TIMEOUT_MS,
    )) as { answers?: unknown; usage?: Assessment['usage']; result?: Assessment };
    const body = res.answers ? res : (res.result ?? res);
    if (!body.answers || typeof body.answers !== 'object') throw new Error('no answers');
    const p: AiProvenance = { source: 'model', model: String(env.ASSESS_MODEL), prompt };
    logAiCall(p, Date.now() - started);
    return {
      value: { answers: clampAnswers(input.questions, body.answers), usage: body.usage },
      ...p,
    };
  } catch (err) {
    return heuristic(err instanceof Error ? err.message : String(err));
  }
}
