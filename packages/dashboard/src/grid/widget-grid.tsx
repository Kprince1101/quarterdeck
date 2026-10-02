import { GridTray } from './grid-tray.js';
import { useWidgetGrid, type WidgetGridProps } from './use-widget-grid.js';
import { WidgetCell } from './widget-cell.js';

export const WidgetGrid = (props: WidgetGridProps) => {
  const { gridRef, gridStyle, cells, controls, tray, announcement } =
    useWidgetGrid(props);
  return (
    <div className="qd-grid-root" data-widget-mount="">
      <GridTray tray={tray} />
      <div ref={gridRef} className="qd-grid" style={gridStyle}>
        {cells.map((cell) => (
          <WidgetCell key={cell.id} cell={cell} controls={controls} />
        ))}
      </div>
      <p id={controls.moveHelpId} hidden>
        Arrow keys move the widget to the next free cell.
      </p>
      <p id={controls.resizeHelpId} hidden>
        Arrow keys resize the widget by one cell.
      </p>
      <p className="qd-visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
};
