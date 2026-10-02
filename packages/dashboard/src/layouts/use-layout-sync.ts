import {
  DEFAULT_PRESET,
  layoutKey,
  presetLayout,
  type GridLayout,
  type PresetName,
} from '@quarterdeck/server/layouts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IntentClient, StreamState } from '../api/index.js';
import { getErrorMessage } from '../lib/errors.js';
import { DASHBOARD_LAYOUT, LAYOUT_SAVE_DELAY_MS } from './constants.js';
import { projectOf, savedLayoutOf } from './layout-source.js';
import { createLayoutWriter, type LayoutWriter } from './layout-writer.js';

export interface LayoutSyncSources {
  stream: StreamState;
  intents: IntentClient;
  delayMs?: number | undefined;
}

export interface LayoutSync {
  initialLayout: GridLayout;
  syncedLayout: GridLayout | null;
  error: string | null;
  handleLayoutChange: (layout: GridLayout) => void;
  resetTo: (preset: PresetName) => void;
}

const useLayoutWriter = (
  delayMs: number,
  setError: (error: string | null) => void,
): LayoutWriter => {
  const [writer] = useState(() =>
    createLayoutWriter({
      delayMs,
      onError: (err) => setError(getErrorMessage(err)),
    }),
  );
  useEffect(() => () => writer.flush(), [writer]);
  return writer;
};

export const useLayoutSync = ({
  stream,
  intents,
  delayMs = LAYOUT_SAVE_DELAY_MS,
}: LayoutSyncSources): LayoutSync => {
  const project = projectOf(stream.tables.projects);
  const saved = useMemo(
    () => savedLayoutOf(stream.tables.layouts, DASHBOARD_LAYOUT),
    [stream.tables.layouts],
  );
  const [error, setError] = useState<string | null>(null);
  const writer = useLayoutWriter(delayMs, setError);
  const [initialLayout] = useState(() => saved ?? presetLayout(DEFAULT_PRESET));
  const [syncedLayout, setSyncedLayout] = useState<GridLayout | null>(null);

  useEffect(() => {
    if (saved === null || writer.isEcho(layoutKey(saved))) return;
    setSyncedLayout(saved);
  }, [saved, writer]);

  const handleLayoutChange = useCallback(
    (spec: GridLayout) => {
      if (project === null) return;
      setError(null);
      writer.write({
        key: layoutKey(spec),
        send: () =>
          intents.layout.save({ project, name: DASHBOARD_LAYOUT, spec }),
      });
    },
    [project, intents, writer],
  );

  const resetTo = useCallback(
    (preset: PresetName) => {
      const layout = presetLayout(preset);
      setSyncedLayout(layout);
      if (project === null) return;
      setError(null);
      writer.write({
        key: layoutKey(layout),
        send: () =>
          intents.layout.reset({ project, name: DASHBOARD_LAYOUT, preset }),
      });
    },
    [project, intents, writer],
  );

  return { initialLayout, syncedLayout, error, handleLayoutChange, resetTo };
};
