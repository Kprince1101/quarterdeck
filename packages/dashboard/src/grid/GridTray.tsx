import type { JSX } from 'react';
import type { GridTrayView, HiddenWidget } from './use-grid-tray.js';

interface GridTrayProps {
  tray: GridTrayView;
}

const AddWidget = ({ tray }: GridTrayProps) => (
  <div className="qd-grid-add">
    <select
      aria-label="Widget to add"
      value={tray.chosen}
      onChange={tray.handleChoose}
    >
      {tray.options.map(({ type, title }) => (
        <option key={type} value={type}>
          {title}
        </option>
      ))}
    </select>
    <button type="button" className="qd-grid-button" onClick={tray.handleAdd}>
      Add
    </button>
  </div>
);

const HiddenItem = ({ widget }: { widget: HiddenWidget }) => (
  <li data-hidden-item={widget.id}>
    <span>{widget.label}</span>
    <button
      type="button"
      className="qd-grid-button"
      aria-label={widget.showLabel}
      onClick={widget.onShow}
    >
      Show
    </button>
    <button
      type="button"
      className="qd-grid-button"
      aria-label={widget.removeLabel}
      onClick={widget.onRemove}
    >
      Remove
    </button>
  </li>
);

export const GridTray = ({ tray }: GridTrayProps): JSX.Element => (
  <section
    ref={tray.trayRef}
    className="qd-grid-tray"
    aria-label="Widgets"
    tabIndex={-1}
  >
    {tray.canAdd && <AddWidget tray={tray} />}
    {tray.hasHidden && (
      <ul className="qd-grid-hidden" aria-label="Hidden widgets">
        {tray.hidden.map((widget) => (
          <HiddenItem key={widget.id} widget={widget} />
        ))}
      </ul>
    )}
  </section>
);
