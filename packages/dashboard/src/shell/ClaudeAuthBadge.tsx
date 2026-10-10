import type { JSX } from 'react';
import { useClaudeAuthBadge } from './use-claude-auth-badge.js';

export const ClaudeAuthBadge = (): JSX.Element | null => {
  const view = useClaudeAuthBadge();
  if (view === null) return null;
  return (
    <span className="qd-auth" data-state={view.state} title={view.title}>
      {view.label}
    </span>
  );
};
