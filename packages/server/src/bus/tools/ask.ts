import { z } from 'zod';
import { ASK_EXPIRY_MS, awaitCard, raiseAskCard } from '../cards.js';
import { BusToolError, defineBusTool } from '../tool.js';

export const QUESTION_MAX = 500;
export const OPTION_MAX = 100;
export const OPTIONS_MAX = 10;
export const CHECKED_MAX = 2000;
export const RECOMMENDATION_MAX = 500;

const text = (max: number) => z.string().trim().min(1).max(max);

export default defineBusTool({
  description: [
    'Ask the person a question that only they can decide. Raises a card on the board and waits until they answer, decline, or the card expires.',
    'Give the question, the options to choose from (omit for a free-text answer), what you already checked, and your recommendation (one of the options when there are options).',
    'Returns JSON {cardId, status, answer}: status answered with their answer, or declined or expired with answer null.',
    'Declined or expired is an answer too: carry on without them, or stop and report.',
  ].join('\n'),
  input: {
    question: text(QUESTION_MAX),
    options: z
      .array(text(OPTION_MAX))
      .max(OPTIONS_MAX)
      .refine(
        (options) => new Set(options).size === options.length,
        'options must not repeat',
      )
      .default([])
      .describe('Choices for the answer; omit or leave empty for free text.'),
    checked: text(CHECKED_MAX).describe(
      'What you already checked or tried before asking.',
    ),
    recommendation: text(RECOMMENDATION_MAX).describe(
      'What you would choose, and why if there are no options.',
    ),
  },
  run: async (call, card) => {
    if (card.options.length === 1)
      throw new BusToolError(
        'give at least two options, or none for free text',
      );
    if (card.options.length > 0 && !card.options.includes(card.recommendation))
      throw new BusToolError(
        `recommendation must be one of the options: ${card.options.join(', ')}`,
      );
    const expiryMs = call.askExpiryMs ?? ASK_EXPIRY_MS;
    const { cardId, expiresAt } = await raiseAskCard(
      call.store,
      call.agentId,
      card,
      expiryMs,
    );
    const outcome = await awaitCard(call.store, cardId, {
      expiryMs,
      signal: call.signal,
      onWaiting: () =>
        call.progress(
          `waiting for an answer to card ${cardId} (expires ${expiresAt.toISOString()})`,
        ),
    });
    return JSON.stringify(outcome);
  },
});
