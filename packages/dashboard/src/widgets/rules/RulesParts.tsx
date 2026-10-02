import type { JSX } from 'react';
import type { RuleView } from '../../api/index.js';

interface MessageProps {
  message: string | null;
}

export const RulesAlert = ({ message }: MessageProps): JSX.Element | null => {
  if (message === null) return null;
  return (
    <pre className="qd-rules-error" role="alert">
      {message}
    </pre>
  );
};

export const RulesStatus = ({ message }: MessageProps): JSX.Element | null => {
  if (message === null) return null;
  return (
    <p className="qd-rules-ok" role="status">
      {message}
    </p>
  );
};

interface LayerHeadingProps {
  title: string;
  path: string;
  readOnly?: boolean;
}

export const LayerHeading = ({
  title,
  path,
  readOnly = false,
}: LayerHeadingProps): JSX.Element => (
  <header className="qd-rules-layer-head">
    <h3>
      {title}
      {readOnly && <span className="qd-rules-tag">read-only</span>}
    </h3>
    <code>{path}</code>
  </header>
);

interface DefaultsLayerProps {
  rule: RuleView;
}

export const DefaultsLayer = ({ rule }: DefaultsLayerProps): JSX.Element => (
  <section className="qd-rules-layer" aria-label="Shipped defaults">
    <LayerHeading title="Shipped defaults" path={rule.defaults.path} readOnly />
    <p className="qd-rules-note">
      Ships with Quarterdeck and is never written. Edits go to the machine
      layer.
    </p>
    <details>
      <summary>Show {rule.file}</summary>
      <pre className="qd-rules-text">{rule.defaults.content}</pre>
    </details>
  </section>
);
