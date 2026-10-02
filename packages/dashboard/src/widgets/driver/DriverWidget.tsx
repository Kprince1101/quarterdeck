import type { RoundRow } from '@quarterdeck/server/stream-schema';
import { valueOf } from '../../grid/dom.js';
import { defineWidget } from '../registry.js';
import type { DriverTurn } from './driver-turns.js';
import { TurnDetailView } from './TurnDetailView.js';
import { useDriverWidget, type DriverWidgetView } from './use-driver-widget.js';

interface RoundPickerProps {
  rounds: RoundRow[];
  round: RoundRow;
  onPick: (roundId: string) => void;
}

const RoundPicker = ({ rounds, round, onPick }: RoundPickerProps) => (
  <div className="qd-driver-round">
    <label>
      Round{' '}
      <select
        value={round.id}
        onChange={(event) => {
          onPick(valueOf(event.currentTarget));
        }}
      >
        {rounds.map(({ id, number, status }) => (
          <option key={id} value={id}>
            {number} ({status})
          </option>
        ))}
      </select>
    </label>
    <p className="qd-driver-goal" title={round.goal}>
      {round.goal}
    </p>
  </div>
);

interface TurnListProps {
  turns: DriverTurn[];
  selected: DriverTurn;
  onPick: (turnId: number) => void;
}

const TurnList = ({ turns, selected, onPick }: TurnListProps) => (
  <ol className="qd-driver-turns" aria-label="Turns">
    {turns.map(({ turn, driver }) => (
      <li key={turn.id}>
        <button
          type="button"
          aria-pressed={turn.id === selected.turn.id}
          data-turn-id={turn.id}
          onClick={() => {
            onPick(turn.id);
          }}
        >
          <span>Turn {turn.seq}</span>
          <span className="qd-driver-meta">
            {driver.name} · {turn.stopReason ?? 'running'}
          </span>
        </button>
      </li>
    ))}
  </ol>
);

const RoundTurns = ({
  view,
  round,
}: {
  view: DriverWidgetView;
  round: RoundRow;
}) => {
  if (view.selected === null) {
    return (
      <p className="qd-empty">No Driver turns in round {round.number} yet.</p>
    );
  }
  return (
    <div className="qd-driver-split">
      <TurnList
        turns={view.turns}
        selected={view.selected}
        onPick={view.selectTurn}
      />
      <TurnDetailView
        project={view.project}
        selected={view.selected}
        detail={view.detail}
      />
    </div>
  );
};

export const DriverWidget = () => {
  const view = useDriverWidget();
  if (view.round === null) return <p className="qd-empty">No rounds yet.</p>;
  return (
    <div className="qd-driver">
      <RoundPicker
        rounds={view.rounds}
        round={view.round}
        onPick={view.selectRound}
      />
      <RoundTurns view={view} round={view.round} />
    </div>
  );
};

export default defineWidget({
  type: 'driver',
  title: 'Driver',
  component: DriverWidget,
  size: { w: 8, h: 12 },
  minSize: { w: 4, h: 4 },
});
