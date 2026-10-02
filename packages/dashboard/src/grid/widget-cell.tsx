import { Panel } from '../shell/shell.js';
import {
  useWidgetCell,
  type WidgetCellProps,
  type WidgetCellView,
} from './use-widget-cell.js';
import { WidgetSlot } from './widget-slot.js';

interface CellControlsProps {
  view: WidgetCellView;
}

const CellControls = ({ view }: CellControlsProps) => (
  <>
    <button
      type="button"
      className="qd-grid-control qd-grid-move"
      aria-label={view.moveLabel}
      title={view.moveLabel}
      aria-describedby={view.moveHelpId}
      aria-keyshortcuts={view.arrowKeys}
      onKeyDown={view.handleMoveKey}
      {...view.moveDrag}
    >
      ⠿
    </button>
    <button
      type="button"
      className="qd-grid-control"
      aria-label={view.duplicateLabel}
      title={view.duplicateLabel}
      onClick={view.handleDuplicate}
    >
      ⧉
    </button>
    <button
      type="button"
      className="qd-grid-control"
      aria-label={view.hideLabel}
      title={view.hideLabel}
      onClick={view.handleHide}
    >
      –
    </button>
  </>
);

export const WidgetCell = ({ cell, controls }: WidgetCellProps) => {
  const view = useWidgetCell({ cell, controls });
  return (
    <div
      className="qd-grid-cell"
      style={cell.style}
      data-grid-item={cell.id}
      data-widget={cell.item.widget}
    >
      <Panel title={cell.label} actions={<CellControls view={view} />}>
        <WidgetSlot
          label={cell.label}
          panes={cell.panes}
          stacked={cell.stacked}
        />
      </Panel>
      <button
        type="button"
        className="qd-grid-resize"
        aria-label={view.resizeLabel}
        title={view.resizeLabel}
        aria-describedby={view.resizeHelpId}
        aria-keyshortcuts={view.arrowKeys}
        onKeyDown={view.handleResizeKey}
        {...view.resizeDrag}
      />
    </div>
  );
};
