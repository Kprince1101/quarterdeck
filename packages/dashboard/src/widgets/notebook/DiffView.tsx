import type { JSX } from 'react';
import type { DiffKind, DiffLine } from '../line-diff.js';

const DIFF_SIGNS: Record<DiffKind, string> = {
  same: ' ',
  added: '+',
  removed: '-',
};

export interface DiffViewProps {
  lines: DiffLine[];
}

export const DiffView = ({ lines }: DiffViewProps): JSX.Element => (
  <ol
    className="qd-notebook-diff"
    aria-label="Changes against the current entry"
  >
    {lines.map((line) => (
      <li key={line.id} data-diff={line.kind}>
        <span className="qd-notebook-diff-sign">{DIFF_SIGNS[line.kind]}</span>
        <span>{line.text}</span>
      </li>
    ))}
  </ol>
);
