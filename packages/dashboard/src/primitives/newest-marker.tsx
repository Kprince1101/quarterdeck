import type { ItemKey } from './tabs.js';
import { useNewestMarker } from './use-newest-marker.js';
import './tab-bar.css';

export interface NewestMarkerProps {
  newest: ItemKey | null;
  onSeen: (key: ItemKey) => void;
}

export const NewestMarker = ({ newest, onSeen }: NewestMarkerProps) => {
  const ref = useNewestMarker(newest, onSeen);
  return (
    <span
      ref={ref}
      className="qd-newest-marker"
      aria-hidden="true"
      data-newest-marker=""
    />
  );
};
