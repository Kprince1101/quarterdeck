import type { JSX } from 'react';

export interface ProjectTagProps {
  project: string;
  isShown: boolean;
}

export const ProjectTag = ({
  project,
  isShown,
}: ProjectTagProps): JSX.Element | null => {
  if (!isShown) return null;
  return <span className="qd-notebook-project">{project}</span>;
};
