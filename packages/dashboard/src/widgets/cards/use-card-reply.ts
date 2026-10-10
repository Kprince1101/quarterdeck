import { useState, type ChangeEvent } from 'react';
import type { AttachmentUpload } from '../../api/index.js';
import { withAttachments } from '../../primitives/index.js';
import { useDeck } from '../../deck/DeckProvider.js';
import { getErrorMessage } from '../../lib/errors.js';
import { withLookupNote, type CardView } from './card-deck.js';

export const NO_PROJECT_ERROR = 'This card has no project to answer in.';
export const REPLY_LABEL = 'Your answer';

export interface ChoiceView {
  option: string;
  isRecommended: boolean;
  handleChoose: () => void;
}

export interface CardReplyView {
  choices: ChoiceView[];
  hasChoices: boolean;
  replyLabel: string;
  canFlagLookup: boolean;
  lookup: boolean;
  isBusy: boolean;
  error: string | null;
  hasError: boolean;
  handleLookupChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleSend: (
    message: string,
    attachments: AttachmentUpload[],
  ) => Promise<void>;
  handleDecline: () => void;
}

const projectOf = (card: CardView): string => {
  if (card.projectSlug === null) throw new Error(NO_PROJECT_ERROR);
  return card.projectSlug;
};

export const useCardReply = (card: CardView): CardReplyView => {
  const { intents } = useDeck();
  const [lookup, setLookup] = useState(false);
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (
    text: string,
    attachments: AttachmentUpload[] = [],
  ): Promise<void> => {
    await intents.card.answer(
      withAttachments(
        { project: projectOf(card), cardId: card.id, answer: text },
        attachments,
      ),
    );
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    if (isBusy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const choices = card.options.map((option) => ({
    option,
    isRecommended: option === card.recommendation,
    handleChoose: () => {
      void run(() => answer(option));
    },
  }));

  return {
    choices,
    hasChoices: choices.length > 0,
    replyLabel: REPLY_LABEL,
    canFlagLookup: card.canFlagLookup,
    lookup,
    isBusy,
    error,
    hasError: error !== null,
    handleLookupChange: ({ currentTarget }) => {
      setLookup(currentTarget.checked);
    },
    handleSend: (message, attachments) =>
      answer(withLookupNote(message, lookup), attachments),
    handleDecline: () => {
      void run(async () => {
        await intents.card.decline({
          project: projectOf(card),
          cardId: card.id,
        });
      });
    },
  };
};
