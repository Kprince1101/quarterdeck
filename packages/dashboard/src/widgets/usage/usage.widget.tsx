import { defineWidget } from '../registry.js';
import { NO_CAP, type UsageLevel } from './usage-model.js';
import { useUsageWidget } from './use-usage-widget.js';
import './usage.css';

interface CapReadoutProps {
  capLoaded: boolean;
  percentLabel: string | null;
  level: UsageLevel | null;
}

const CapReadout = ({ capLoaded, percentLabel, level }: CapReadoutProps) => {
  if (!capLoaded) return null;
  if (percentLabel === null || level === null) {
    return <p className="qd-usage-no-cap">{NO_CAP}</p>;
  }
  return (
    <p className="qd-usage-percent" data-level={level}>
      {percentLabel}
      <span className="qd-usage-of-cap"> of cap</span>
    </p>
  );
};

interface CapErrorProps {
  error: string | null;
}

const CapError = ({ error }: CapErrorProps) => {
  if (error === null) return null;
  return (
    <p className="qd-usage-error" role="alert">
      {error}
    </p>
  );
};

export const UsageWidget = () => {
  const { tokensLabel, percentLabel, level, capLoaded, capError } =
    useUsageWidget();
  return (
    <div className="qd-usage">
      <CapReadout
        capLoaded={capLoaded}
        percentLabel={percentLabel}
        level={level}
      />
      <p className="qd-usage-tokens">{tokensLabel}</p>
      <CapError error={capError} />
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
