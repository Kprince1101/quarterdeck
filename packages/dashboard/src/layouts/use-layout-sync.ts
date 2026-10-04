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

const flushOnLeave = <Target>(writer: LayoutWriter<Target>): (() => void) => {
  const leave = () => writer.flush({ keepalive: true });
  const hidden = () => {
    if (document.visibilityState === 'hidden') leave();
  };
  window.addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    window.removeEventListener('pagehide', leave);
    document.removeEventListener('visibilitychange', hidden);
  };
};

const useLayoutWriter = <Target>(
  delayMs: number,
  setError: (error: string | null) => void,
): LayoutWriter<Target> => {
  const [writer] = useState(() =>
    createLayoutWriter<Target>({
      delayMs,
      onError: (err) => setError(getErrorMessage(err)),
    }),
  );
  useEffect(() => {
    const stopListening = flushOnLeave(writer);
    return () => {
      stopListening();
      writer.flush();
    };
  }, [writer]);
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
  const writer = useLayoutWriter<string>(delayMs, setError);
  const [initialLayout] = useState(() => saved ?? presetLayout(DEFAULT_PRESET));
  const [syncedLayout, setSyncedLayout] = useState<GridLayout | null>(null);

  useEffect(() => {
    if (saved === null || writer.isEcho(layoutKey(saved))) return;
    if (writer.hasQueued()) return;
    setSyncedLayout(saved);
  }, [saved, writer]);

  useEffect(() => {
    writer.setTarget(project);
  }, [project, writer]);

  const handleLayoutChange = useCallback(
    (spec: GridLayout) => {
      setError(null);
      writer.write({
        key: layoutKey(spec),
        send: (to, options) =>
          intents.layout.save(
            { project: to, name: DASHBOARD_LAYOUT, spec },
            options,
          ),
      });
    },
    [intents, writer],
  );

  const resetTo = useCallback(
    (preset: PresetName) => {
      const layout = presetLayout(preset);
      setSyncedLayout(layout);
      setError(null);
      writer.write({
        key: layoutKey(layout),
        send: (to, options) =>
          intents.layout.reset(
            { project: to, name: DASHBOARD_LAYOUT, preset },
            options,
          ),
      });
    },
    [intents, writer],
  );

  return { initialLayout, syncedLayout, error, handleLayoutChange, resetTo };
};
