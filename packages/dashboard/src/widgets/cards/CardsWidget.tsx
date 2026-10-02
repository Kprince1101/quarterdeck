import { defineWidget } from '../registry.js';
import { LOOKUP_LABEL, type CardView } from './card-deck.js';
import { CardFacts, CardHead, CardTicket } from './CardParts.js';
import { CardReply } from './CardReply.js';
import './cards.css';
import { useCardsWidget } from './use-cards-widget.js';

interface CardProps {
  card: CardView;
}

const OpenCard = ({ card }: CardProps) => (
  <article className="qd-card" data-card-id={card.id} data-status="open">
    <CardHead card={card} at={card.askedAt} age={card.askedAge} />
    <CardTicket ticket={card.ticket} />
    <p className="qd-card-question">{card.question}</p>
    <CardFacts card={card} />
    <CardReply card={card} />
  </article>
);

const AnsweredCard = ({ card }: CardProps) => (
  <article className="qd-card" data-card-id={card.id} data-status={card.status}>
    <CardHead card={card} at={card.settledAt} age={card.settledAge} />
    <CardTicket ticket={card.ticket} />
    <p className="qd-card-question">{card.question}</p>
    <p className="qd-card-answer">
      <span className="qd-card-status">{card.statusLabel}</span>
      {card.answer !== null && (
        <span className="qd-card-answer-text">{card.answer}</span>
      )}
    </p>
    {card.lookup && <p className="qd-card-lookup">{LOOKUP_LABEL}</p>}
  </article>
);

interface CardListProps {
  cards: CardView[];
}

const OpenCards = ({ cards }: CardListProps) => (
  <ol className="qd-card-list" aria-label="Open cards">
    {cards.map((card) => (
      <li key={card.id}>
        <OpenCard card={card} />
      </li>
    ))}
  </ol>
);

interface AnsweredCardsProps extends CardListProps {
  id: string;
  hasHistory: boolean;
}

const AnsweredCards = ({ id, cards, hasHistory }: AnsweredCardsProps) => {
  if (!hasHistory) {
    return (
      <p id={id} className="qd-empty">
        Nothing answered yet.
      </p>
    );
  }
  return (
    <ol id={id} className="qd-card-list" aria-label="Answered cards">
      {cards.map((card) => (
        <li key={card.id}>
          <AnsweredCard card={card} />
        </li>
      ))}
    </ol>
  );
};

export const CardsWidget = () => {
  const view = useCardsWidget();
  return (
    <div className="qd-cards">
      {view.hasOpen && <OpenCards cards={view.open} />}
      {!view.hasOpen && <p className="qd-empty">No open cards.</p>}
      <button
        type="button"
        className="qd-cards-history-toggle"
        aria-expanded={view.showHistory}
        aria-controls={view.historyControls}
        onClick={view.handleToggleHistory}
      >
        {view.historyLabel}
      </button>
      {view.showHistory && (
        <AnsweredCards
          id={view.historyId}
          cards={view.answered}
          hasHistory={view.hasHistory}
        />
      )}
    </div>
  );
};

export default defineWidget({
  type: 'cards',
  title: 'Cards',
  component: CardsWidget,
  size: { w: 4, h: 8 },
  minSize: { w: 3, h: 3 },
});
