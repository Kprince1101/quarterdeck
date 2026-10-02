import type { JSX } from 'react';
import { ChatInput } from '../../primitives/index.js';
import { LOOKUP_LABEL, type CardView } from './card-deck.js';
import { useCardReply, type ChoiceView } from './use-card-reply.js';

interface ChoiceButtonsProps {
  choices: ChoiceView[];
  disabled: boolean;
}

const ChoiceButtons = ({ choices, disabled }: ChoiceButtonsProps) => (
  <div className="qd-card-choices" role="group" aria-label="Choices">
    {choices.map((choice) => (
      <button
        key={choice.option}
        type="button"
        className="qd-card-choice"
        data-recommended={choice.isRecommended}
        disabled={disabled}
        onClick={choice.handleChoose}
      >
        {choice.option}
        {choice.isRecommended && (
          <span className="qd-card-recommended"> (recommended)</span>
        )}
      </button>
    ))}
  </div>
);

interface CardReplyProps {
  card: CardView;
}

export const CardReply = ({ card }: CardReplyProps): JSX.Element => {
  const view = useCardReply(card);
  return (
    <div className="qd-card-reply">
      {view.hasChoices && (
        <ChoiceButtons choices={view.choices} disabled={view.isBusy} />
      )}
      {!view.hasChoices && (
        <ChatInput
          label={view.replyLabel}
          onSubmit={view.handleSend}
          disabled={view.isBusy}
        />
      )}
      <div className="qd-card-actions">
        {view.canFlagLookup && (
          <label className="qd-card-lookup-toggle">
            <input
              type="checkbox"
              checked={view.lookup}
              onChange={view.handleLookupChange}
            />
            {LOOKUP_LABEL}
          </label>
        )}
        <button
          type="button"
          className="qd-card-decline"
          disabled={view.isBusy}
          onClick={view.handleDecline}
        >
          Decline
        </button>
      </div>
      {view.hasError && (
        <p className="qd-card-error" role="alert">
          {view.error}
        </p>
      )}
    </div>
  );
};
