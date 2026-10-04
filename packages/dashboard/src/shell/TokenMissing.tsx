import { QUARTERDECK_COMMAND } from '@quarterdeck/server/replay-command';
import type { JSX } from 'react';

export const TokenMissing = (): JSX.Element => (
  <div className="qd-token-missing" role="alert">
    <h1 className="qd-brand">Quarterdeck</h1>
    <p>
      Open the link printed by <code>{QUARTERDECK_COMMAND} up</code>.
    </p>
  </div>
);
