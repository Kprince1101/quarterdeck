import type { CardView } from './card-deck.js';

interface CardHeadProps {
  card: CardView;
  at: string;
  age: string;
}

export const CardHead = ({ card, at, age }: CardHeadProps) => (
  <header className="qd-card-head">
    <span className="qd-card-kind" data-kind={card.kind}>
      {card.label}
    </span>
    <span className="qd-card-source">
      {card.project}
      {card.from !== null && (
        <span className="qd-card-from"> · {card.from}</span>
      )}
    </span>
    <time dateTime={at} title={at}>
      {age}
    </time>
  </header>
);

interface CardTicketProps {
  ticket: string | null;
}

export const CardTicket = ({ ticket }: CardTicketProps) => {
  if (ticket === null) return null;
  return <p className="qd-card-ticket">Ticket: {ticket}</p>;
};

interface RecommendationProps {
  text: string;
  isCommand: boolean;
}

const Recommendation = ({ text, isCommand }: RecommendationProps) => {
  if (isCommand) return <code className="qd-card-command">{text}</code>;
  return <span>{text}</span>;
};

interface CardFactsProps {
  card: CardView;
}

export const CardFacts = ({ card }: CardFactsProps) => {
  if (card.checked === null && card.recommendation === null) return null;
  return (
    <dl className="qd-card-facts">
      {card.checked !== null && (
        <div data-fact="checked">
          <dt>{card.checkedLabel}</dt>
          <dd>{card.checked}</dd>
        </div>
      )}
      {card.recommendation !== null && (
        <div data-fact="recommendation">
          <dt>{card.recommendationLabel}</dt>
          <dd>
            <Recommendation
              text={card.recommendation}
              isCommand={card.isCommand}
            />
          </dd>
        </div>
      )}
    </dl>
  );
};
