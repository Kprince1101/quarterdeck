import type { JSX } from 'react';
import type { WidgetRegistry } from '../widgets/registry.js';
import { WidgetMount } from '../widgets/WidgetMount.js';
import { LayoutBar } from './LayoutBar.js';
import { useDeckLayout } from './use-deck-layout.js';

export interface DeckLayoutProps {
  registry?: WidgetRegistry | undefined;
  saveDelayMs?: number | undefined;
}

export const DeckLayout = ({
  registry,
  saveDelayMs,
}: DeckLayoutProps): JSX.Element => {
  const view = useDeckLayout({ saveDelayMs });
  return (
    <div className="qd-layout">
      <LayoutBar view={view} />
      <WidgetMount
        registry={registry}
        initialLayout={view.initialLayout}
        syncedLayout={view.syncedLayout}
        onLayoutChange={view.handleLayoutChange}
      />
    </div>
  );
};
