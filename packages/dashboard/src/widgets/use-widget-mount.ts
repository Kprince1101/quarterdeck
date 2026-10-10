import { useMemo } from 'react';
import { useWorkspaceMode } from '../deck/DeckProvider.js';
import { registryFor, type WidgetRegistry } from './registry.js';

export const useWidgetMount = (registry: WidgetRegistry): WidgetRegistry => {
  const mode = useWorkspaceMode();
  return useMemo(() => registryFor(registry, mode), [registry, mode]);
};
