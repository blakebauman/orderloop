/**
 * One assistant turn as a UI message stream, asked once more if the model stops without answering.
 *
 * Kimi sometimes ends a step having only thought: no text and no tool call, with a normal finish.
 * The tool loop goes on only after tool calls, so the turn would end there and the person would get
 * nothing. Instead the model is asked once more, in the same reply, with what it has done so far
 * and `NUDGE`. The nudge is for the model only and never joins the conversation. If the second try
 * also says nothing, the panel shows "Stopped without an answer".
 */

import {
  createUIMessageStream,
  type ModelMessage,
  type StepResult,
  type streamText,
  type ToolSet,
  type UIMessageChunk,
} from 'ai';

export const NUDGE =
  'You stopped without answering. Answer the question now: call a tool, or reply to the person.';

type Run = (
  messages: ModelMessage[],
  steps: number,
) => Pick<ReturnType<typeof streamText>, 'toUIMessageStream' | 'steps' | 'response'>;

/** A step that ended normally with nothing for the person: no words and no tool call. */
export function thoughtOnly(
  step: Pick<StepResult<ToolSet>, 'finishReason' | 'text' | 'toolCalls'>,
) {
  return step.finishReason === 'stop' && step.text.trim() === '' && step.toolCalls.length === 0;
}

export function answerStream(
  run: Run,
  messages: ModelMessage[],
  options: {
    /** The turn's step budget, shared by both tries. */
    steps: number;
    /** The reply's metadata, sent with its finish. */
    metadata: () => unknown;
    signal?: AbortSignal;
    /** Runs once the reply has ended. */
    onDone?: () => Promise<void>;
  },
): ReadableStream<UIMessageChunk> {
  const messageMetadata = ({ part }: { part: { type: string } }) =>
    part.type === 'finish' ? options.metadata() : undefined;
  return createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        const first = run(messages, options.steps);
        // Copied chunk by chunk, not merged, so the finish below can't overtake them.
        for await (const chunk of first.toUIMessageStream({ sendFinish: false, messageMetadata }))
          writer.write(chunk);
        const taken = await Promise.resolve(first.steps).catch(() => []);
        const last = taken.at(-1);
        if (!last || !thoughtOnly(last) || taken.length >= options.steps || options.signal?.aborted)
          return writer.write({ type: 'finish', messageMetadata: options.metadata() });
        const again = run(
          [...messages, ...(await first.response).messages, { role: 'user', content: NUDGE }],
          options.steps - taken.length,
        );
        for await (const chunk of again.toUIMessageStream({ sendStart: false, messageMetadata }))
          writer.write(chunk);
      } finally {
        await options.onDone?.();
      }
    },
  });
}
