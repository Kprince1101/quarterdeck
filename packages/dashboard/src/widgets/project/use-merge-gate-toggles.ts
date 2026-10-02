import { useMemo } from 'react';
import { useDeck } from '../../deck/deck.js';
import { useIntentRequest } from '../use-intent-request.js';
import {
  gateToggles,
  toggledLayer,
  type GateKey,
  type GateToggle,
} from './merge-gate.js';
import type { ProjectPanel } from './project-model.js';
import { useLifecycleRule } from './use-lifecycle-rule.js';

export interface GateToggleView extends GateToggle {
  isDisabled: boolean;
  handleChange: () => void;
}

export interface MergeGateTogglesView {
  toggles: GateToggleView[];
  error: string | null;
}

export const useMergeGateToggles = (
  panel: ProjectPanel,
): MergeGateTogglesView => {
  const { intents } = useDeck();
  const { rule, loadError, read, show } = useLifecycleRule(panel.slug);
  const { isPending, error, run } = useIntentRequest();
  const shown = useMemo(() => rule && gateToggles(rule), [rule]);

  const toggle = async (key: GateKey) => {
    const content = toggledLayer(await read(), key);
    await intents.rules.write({ scope: 'machine', name: 'lifecycle', content });
    show(await read());
  };

  const toggles = (shown?.toggles ?? []).map((gate) => ({
    ...gate,
    isDisabled: isPending || gate.pinnedByRepo,
    handleChange: () => {
      void run(() => toggle(gate.key));
    },
  }));
  return { toggles, error: error ?? loadError ?? shown?.error ?? null };
};
