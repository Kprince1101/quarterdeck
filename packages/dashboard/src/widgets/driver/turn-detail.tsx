import type { TurnReadResult } from '@quarterdeck/server/intents';
import { replayCommand } from '@quarterdeck/server/replay-command';
import type { DriverTurn } from './driver-turns.js';
import { useCopy, type CopyState } from './use-copy.js';
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

interface ReplayCommandProps {
  project: string;
  read: TurnReadResult;
}

const ReplayCommand = ({ project, read }: ReplayCommandProps) => {
  if (read.round === null || read.n === null) {
    return <p className="qd-empty">Not part of a Driver round; no replay.</p>;
  }
  if (!read.latestSession) {
    return (
      <p className="qd-empty">
        Round {read.round} has a later Driver session, and replay runs only the
        latest.
      </p>
    );
  }
  return (
    <CopyCommand
      command={replayCommand({ round: read.round, through: read.n, project })}
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
}: TurnDetailViewProps) => {
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
