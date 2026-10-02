import type { JSX } from 'react';
import { defineWidget } from '../registry.js';
import { NO_CAP, type UsageView } from './usage-model.js';
import { useUsageWidget } from './use-usage-widget.js';
import './usage.css';

interface CapReadoutProps {
  view: UsageView;
}

const CapReadout = ({ view }: CapReadoutProps) => {
  if (view.percentLabel === null || view.level === null) {
    return <p className="qd-usage-no-cap">{NO_CAP}</p>;
  }
  return (
    <p className="qd-usage-percent" data-level={view.level}>
      {view.percentLabel}
      <span className="qd-usage-of-cap"> of cap</span>
    </p>
  );
};

interface UsageReadoutProps {
  view: UsageView | null;
}

const UsageReadout = ({ view }: UsageReadoutProps) => {
  if (view === null) return <p className="qd-empty">Reading usage…</p>;
  return (
    <>
      <CapReadout view={view} />
      <p className="qd-usage-tokens">{view.usedLabel}</p>
    </>
  );
};

interface UsageErrorProps {
  error: string | null;
}

const UsageError = ({ error }: UsageErrorProps) => {
  if (error === null) return null;
  return (
    <p className="qd-usage-error" role="alert">
      {error}
    </p>
  );
};

export const UsageWidget = (): JSX.Element => {
  const { view, error } = useUsageWidget();
  return (
    <div className="qd-usage">
      <UsageReadout view={view} />
      <UsageError error={error} />
    </div>
  );
};

export default defineWidget({
  type: 'usage',
  title: 'Usage',
  component: UsageWidget,
  size: { w: 3, h: 3 },
  minSize: { w: 2, h: 2 },
  startHidden: true,
});
