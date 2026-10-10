import type { WorkspaceMode } from '@quarterdeck/server/stream-schema';
import { repositoryWording } from '@quarterdeck/server/workspace-wording';

export type Wording = (text: string) => string;

const asIs: Wording = (text) => text;

export const wordingFor = (mode: WorkspaceMode): Wording => {
  if (mode === 'single') return repositoryWording;
  return asIs;
};
