import {
  DASHBOARD_LAYOUT,
  DEFAULT_PRESET,
  layoutKey,
  presetLayout,
  type GridLayout,
  type PresetName,
} from '@quarterdeck/server/layouts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IntentClient, StreamState } from '../api/index.js';
import { getErrorMessage } from '../lib/errors.js';
import { LAYOUT_SAVE_DELAY_MS } from './constants.js';
import { hasSnapshot, savedLayoutOf } from './layout-source.js';
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

const flushOnLeave = (writer: LayoutWriter): (() => void) => {
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
  const ready = hasSnapshot(stream);
  const saved = useMemo(() => savedLayoutOf(stream.layout), [stream.layout]);
  const [error, setError] = useState<string | null>(null);
  const writer = useLayoutWriter(delayMs, setError);
  const [initialLayout] = useState(() => saved ?? presetLayout(DEFAULT_PRESET));
  const [syncedLayout, setSyncedLayout] = useState<GridLayout | null>(null);

  useEffect(() => {
    if (saved === null || writer.isEcho(layoutKey(saved))) return;
    if (writer.hasQueued()) return;
    setSyncedLayout(saved);
  }, [saved, writer]);

  useEffect(() => {
    writer.setReady(ready);
  }, [ready, writer]);

  const handleLayoutChange = useCallback(
    (spec: GridLayout) => {
      setError(null);
      writer.write({
        key: layoutKey(spec),
        send: (options) =>
          intents.layout.save({ name: DASHBOARD_LAYOUT, spec }, options),
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
        send: (options) =>
          intents.layout.reset({ name: DASHBOARD_LAYOUT, preset }, options),
      });
    },
    [intents, writer],
  );

  return { initialLayout, syncedLayout, error, handleLayoutChange, resetTo };
};
