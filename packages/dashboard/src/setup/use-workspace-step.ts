import { useState, type ChangeEvent, type FormEvent } from 'react';
import {
  setupDetectResultSchema,
  type SetupDetectResult,
} from '@quarterdeck/server/intents';
import type { IntentClient } from '../api/index.js';
import { useIntentRequest } from '../widgets/use-intent-request.js';
import {
  detectionSummary,
  keptCount,
  repositoryRows,
  type RepositoryRow,
} from './setup-model.js';

export interface RepositoryChoice extends RepositoryRow {
  handleToggle: () => void;
}

export interface WorkspaceStepView {
  path: string;
  root: string | null;
  summary: string | null;
  repositories: RepositoryChoice[];
  showsRepositories: boolean;
  skip: string[];
  isDone: boolean;
  isPending: boolean;
  canDetect: boolean;
  error: string | null;
  handlePathChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleDetect: (event: FormEvent<HTMLFormElement>) => void;
}

const toggled = (skipped: ReadonlySet<string>, slug: string): Set<string> => {
  const next = new Set(skipped);
  if (next.has(slug)) next.delete(slug);
  else next.add(slug);
  return next;
};

export const useWorkspaceStep = (intents: IntentClient): WorkspaceStepView => {
  const [path, setPath] = useState('');
  const [detection, setDetection] = useState<SetupDetectResult | null>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const { isPending, error, run } = useIntentRequest();
  const rows = repositoryRows(detection, skipped);

  const detect = async () => {
    const reply = await intents.setup.detect({ path });
    setDetection(setupDetectResultSchema.parse(reply.result));
    setSkipped(new Set());
  };

  return {
    path,
    root: detection?.root ?? null,
    summary: detectionSummary(detection),
    repositories: rows.map((row) => ({
      ...row,
      handleToggle: () => setSkipped((last) => toggled(last, row.slug)),
    })),
    showsRepositories: detection?.mode === 'multi',
    skip: [...skipped],
    isDone: detection !== null && keptCount(rows) > 0,
    isPending,
    canDetect: path.trim() !== '' && !isPending,
    error,
    handlePathChange: (event) => {
      setPath(event.target.value);
      setDetection(null);
    },
    handleDetect: (event) => {
      event.preventDefault();
      void run(detect);
    },
  };
};
