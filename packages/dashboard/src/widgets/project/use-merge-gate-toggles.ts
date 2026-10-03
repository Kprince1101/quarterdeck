import { useMemo } from 'react';
import { useDeck } from '../../deck/DeckProvider.js';
import { useIntentRequest } from '../use-intent-request.js';
import { useForgeTerms } from '../../lib/use-forge-terms.js';
import {
  autoMergeWarning,
  gateLayer,
  gateToggles,
  needsConfirm,
  type GateKey,
  type GateToggle,
} from './merge-gate.js';
import type { ProjectPanel } from './project-model.js';
import { useConfirm } from './use-confirm.js';
import { useLifecycleRule } from './use-lifecycle-rule.js';

export interface GateToggleView extends GateToggle {
  isDisabled: boolean;
  handleChange: () => void;
}

export interface MergeGateTogglesView {
  toggles: GateToggleView[];
  error: string | null;
  isConfirmingAutoMerge: boolean;
  isConfirmDisabled: boolean;
  autoMergeWarning: string;
  handleConfirmAutoMerge: () => void;
  handleCancelAutoMerge: () => void;
}

export const useMergeGateToggles = (
  panel: ProjectPanel,
): MergeGateTogglesView => {
  const { intents } = useDeck();
  const { rule, loadError, read, show } = useLifecycleRule(panel.slug);
  const { isPending, error, run } = useIntentRequest();
  const autoMerge = useConfirm();
  const forge = useForgeTerms(panel.slug, autoMerge.isConfirming);
  const shown = useMemo(() => rule && gateToggles(rule), [rule]);

  const write = (key: GateKey, value: boolean) => {
    void run(async () => {
      const content = gateLayer(await read(), key, value);
      await intents.rules.write({
        scope: 'machine',
        name: 'lifecycle',
        content,
      });
      show(await read());
    });
  };

  const toggles = (shown?.toggles ?? []).map((gate) => ({
    ...gate,
    isDisabled: isPending || gate.pinnedByRepo || autoMerge.isConfirming,
    handleChange: () => {
      const value = !gate.checked;
      if (needsConfirm(gate.key, value)) {
        autoMerge.handleAsk();
        return;
      }
      write(gate.key, value);
    },
  }));
  return {
    toggles,
    error: error ?? loadError ?? shown?.error ?? forge.error,
    isConfirmingAutoMerge: autoMerge.isConfirming,
    isConfirmDisabled: !forge.isRead,
    autoMergeWarning: autoMergeWarning(forge.terms),
    handleConfirmAutoMerge: () => {
      autoMerge.settle();
      write('autoMerge', true);
    },
    handleCancelAutoMerge: autoMerge.handleCancel,
  };
};
