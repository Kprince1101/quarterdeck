import type { JSX } from 'react';
import { useNewestMarker, type NewestMarkerView } from './use-newest-marker.js';
import './tab-bar.css';

export const NewestMarker = (props: NewestMarkerView): JSX.Element => {
  const ref = useNewestMarker(props);
  return (
    <span
      ref={ref}
      className="qd-newest-marker"
      aria-hidden="true"
      data-newest-marker=""
    />
  );
};
