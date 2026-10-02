import type { ReactNode } from 'react';
import type { StreamState, StreamStatus } from '../api/index.js';
import { useDeck } from '../deck/deck.js';

export const STATUS_LABELS: Record<StreamStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  closed: 'Disconnected',
};

export const StreamStatusBadge = ({ stream }: { stream: StreamState }) => (
  <span
    className="qd-status"
    data-status={stream.status}
    role="status"
    title={stream.error ?? undefined}
  >
    {STATUS_LABELS[stream.status]}
  </span>
);

export interface ShellProps {
  mode?: string | undefined;
  children?: ReactNode;
}

export const Shell = ({ mode, children }: ShellProps) => {
  const { stream } = useDeck();
  const hasMode = mode !== undefined;
  return (
    <div className="qd-shell">
      <header className="qd-header">
        <h1 className="qd-brand">Quarterdeck</h1>
        {hasMode && <span className="qd-mode">{mode}</span>}
        <div className="qd-header-end">
          <StreamStatusBadge stream={stream} />
        </div>
      </header>
      <main className="qd-workspace">{children}</main>
    </div>
  );
};

export interface PanelProps {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}

export const Panel = ({ title, actions, children }: PanelProps) => (
  <section className="qd-panel" aria-label={title}>
    <header className="qd-panel-header">
      <h2 className="qd-panel-title">{title}</h2>
      <div className="qd-panel-actions">{actions}</div>
    </header>
    <div className="qd-panel-body">{children}</div>
  </section>
);
