import type { JSX } from 'react';
import { useKeepAwake } from './use-keep-awake.js';

export const KeepAwakeControl = (): JSX.Element => {
  const view = useKeepAwake();
  return (
    <div className="qd-keep-awake" data-on={view.isOn} title={view.title}>
      <div className="qd-keep-awake-controls">
        <select
          aria-label="Keep awake for"
          value={view.choice}
          onChange={view.handleChoose}
          disabled={view.isDisabled}
        >
          {view.choices.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={view.isOn}
          onClick={view.handleToggle}
          disabled={view.isDisabled}
        >
          {view.buttonLabel}
        </button>
      </div>
      <span className="qd-keep-awake-note">{view.note}</span>
      {view.hasError && (
        <span className="qd-keep-awake-error" role="alert">
          {view.error}
        </span>
      )}
    </div>
  );
};
