import type { JSX } from 'react';
import type { VoyageRow } from '@quarterdeck/server/stream-schema';
import { valueOf } from '../../grid/dom.js';
import { defineWidget } from '../registry.js';
import type { DriverTurn } from './driver-turns.js';
import { TurnDetailView } from './TurnDetailView.js';
import { useDriverWidget, type DriverWidgetView } from './use-driver-widget.js';

interface VoyagePickerProps {
  voyages: VoyageRow[];
  voyage: VoyageRow;
  onPick: (voyageId: string) => void;
}

const VoyagePicker = ({ voyages, voyage, onPick }: VoyagePickerProps) => (
  <div className="qd-driver-voyage">
    <label>
      Voyage{' '}
      <select
        value={voyage.id}
        onChange={(event) => {
          onPick(valueOf(event.currentTarget));
        }}
      >
        {voyages.map(({ id, number, status }) => (
          <option key={id} value={id}>
            {number} ({status})
          </option>
        ))}
      </select>
    </label>
    <p className="qd-driver-goal" title={voyage.goal}>
      {voyage.goal}
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

const VoyageTurns = ({
  view,
  voyage,
}: {
  view: DriverWidgetView;
  voyage: VoyageRow;
}) => {
  if (view.selected === null) {
    return (
      <p className="qd-empty">No Driver turns in voyage {voyage.number} yet.</p>
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

export const DriverWidget = (): JSX.Element => {
  const view = useDriverWidget();
  if (view.voyage === null) return <p className="qd-empty">No voyages yet.</p>;
  return (
    <div className="qd-driver">
      <VoyagePicker
        voyages={view.voyages}
        voyage={view.voyage}
        onPick={view.selectVoyage}
      />
      <VoyageTurns view={view} voyage={view.voyage} />
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
