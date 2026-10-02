import type { DeckLayoutView } from './use-deck-layout.js';

interface LayoutBarProps {
  view: DeckLayoutView;
}

export const LayoutBar = ({ view }: LayoutBarProps) => (
  <section className="qd-layout-bar" aria-label="Layout">
    <select
      className="qd-grid-button"
      aria-label="Layout preset"
      value={view.chosenPreset}
      onChange={view.handleChoosePreset}
    >
      {view.presets.map(({ name, title }) => (
        <option key={name} value={name}>
          {title}
        </option>
      ))}
    </select>
    <button type="button" className="qd-grid-button" onClick={view.handleReset}>
      Reset to preset
    </button>
    {view.hasError && (
      <p className="qd-layout-error" role="alert">
        {view.error}
      </p>
    )}
  </section>
);
