import type { JSX } from 'react';
import { useWorkspaceMode } from '../../deck/DeckProvider.js';

export interface ProjectTagProps {
  project: string;
  isShown: boolean;
}

export const ProjectTag = ({
  project,
  isShown,
}: ProjectTagProps): JSX.Element | null => {
  const isMulti = useWorkspaceMode() === 'multi';
  if (!isShown || !isMulti) return null;
  return <span className="qd-notebook-project">{project}</span>;
};
