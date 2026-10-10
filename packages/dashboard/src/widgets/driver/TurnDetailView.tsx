import type { JSX } from 'react';
import type { TurnReadResult } from '@quarterdeck/server/intents';
import { replayCommand } from '@quarterdeck/server/replay-command';
import { useWorkspaceMode } from '../../deck/DeckProvider.js';
import type { DriverTurn } from './driver-turns.js';
import { useCopy, type CopyState } from './use-copy.js';
import { useThroughCommand } from './use-through-command.js';
import type { TurnDetail } from './use-turn-detail.js';

const COPY_NOTES: Record<CopyState, string> = {
  idle: '',
  copied: 'Copied',
  failed: 'Copy failed',
};

const CopyCommand = ({ command }: { command: string }) => {
  const { state, copy } = useCopy(command);
  return (
    <div className="qd-driver-command">
      <code>{command}</code>
      <button type="button" onClick={copy}>
        Copy
      </button>
      <span className="qd-driver-copied" aria-live="polite">
        {COPY_NOTES[state]}
      </span>
    </div>
  );
};

interface ThroughCommandProps {
  project: string;
  voyage: number;
  last: number;
}

const ThroughCommand = ({ project, voyage, last }: ThroughCommandProps) => {
  const { text, through, handleChange } = useThroughCommand(last);
  const isMulti = useWorkspaceMode() === 'multi';
  return (
    <div className="qd-driver-replay">
      <label className="qd-driver-through">
        Replay voyage {voyage} through turn{' '}
        <input
          type="number"
          min={1}
          max={last}
          step={1}
          value={text}
          onChange={handleChange}
        />
      </label>
      {through === null && (
        <p className="qd-driver-error">
          Turn is a whole number from 1 to {last}.
        </p>
      )}
      {through !== null && (
        <CopyCommand
          command={replayCommand({
            voyage,
            through,
            ...(isMulti && { project }),
          })}
        />
      )}
    </div>
  );
};

interface ReplayCommandProps {
  project: string;
  read: TurnReadResult;
}

const ReplayCommand = ({ project, read }: ReplayCommandProps) => {
  if (read.voyage === null || read.n === null) {
    return <p className="qd-empty">Not part of a Driver voyage; no replay.</p>;
  }
  if (!read.latestSession) {
    return (
      <p className="qd-empty">
        Voyage {read.voyage} has a later Driver session, and replay runs only
        the latest.
      </p>
    );
  }
  return (
    <ThroughCommand
      key={read.turnId}
      project={project}
      voyage={read.voyage}
      last={read.n}
    />
  );
};

const Block = ({ title, text }: { title: string; text: string | null }) => (
  <section className="qd-driver-block" aria-label={title}>
    <h4>{title}</h4>
    {text === null && <p className="qd-empty">None yet.</p>}
    {text !== null && <pre>{text}</pre>}
  </section>
);

const resultText = (result: TurnReadResult['result']): string | null => {
  if (result === null) return null;
  return JSON.stringify(result, null, 2);
};

interface DetailBodyProps {
  project: string;
  detail: TurnDetail;
}

const DetailBody = ({ project, detail }: DetailBodyProps) => {
  if (detail.status === 'loading') {
    return <p className="qd-empty">Loading the turn…</p>;
  }
  if (detail.status === 'failed') {
    return (
      <p className="qd-driver-error" role="alert">
        {detail.error}
      </p>
    );
  }
  const { read } = detail;
  return (
    <>
      <ReplayCommand project={project} read={read} />
      <Block title="Input" text={read.input} />
      <Block title="Output" text={read.output} />
      <Block title="Result" text={resultText(read.result)} />
    </>
  );
};

export interface TurnDetailViewProps {
  project: string | null;
  selected: DriverTurn;
  detail: TurnDetail | null;
}

export const TurnDetailView = ({
  project,
  selected,
  detail,
}: TurnDetailViewProps): JSX.Element => {
  const { turn, driver } = selected;
  return (
    <section className="qd-driver-detail" aria-label="Turn detail">
      <header>
        <h3>
          Turn {turn.seq} · {driver.name}
        </h3>
        <p className="qd-driver-meta">
          {turn.stopReason ?? 'running'} · {turn.inputTokens} in /{' '}
          {turn.outputTokens} out ·{' '}
          <time dateTime={turn.startedAt}>{turn.startedAt}</time>
        </p>
      </header>
      {project !== null && detail !== null && (
        <DetailBody project={project} detail={detail} />
      )}
    </section>
  );
};
