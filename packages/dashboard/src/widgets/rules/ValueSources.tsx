import type { JSX } from 'react';
import type { ValueSource } from './rule-layers.js';

interface ValueSourcesProps {
  sources: ValueSource[];
}

const SourceRow = ({ source }: { source: ValueSource }) => (
  <tr data-layer={source.layer}>
    <th scope="row">
      <code>{source.key}</code>
      {source.tightenOnly && (
        <span
          className="qd-rules-tag"
          title="The repo layer can only tighten this"
        >
          tighten-only
        </span>
      )}
    </th>
    <td>
      <code className="qd-rules-value">{source.value}</code>
    </td>
    <td>
      <span className="qd-rules-source">{source.layer}</span>
    </td>
  </tr>
);

export const ValueSources = ({
  sources,
}: ValueSourcesProps): JSX.Element | null => {
  if (sources.length === 0) return null;
  return (
    <section className="qd-rules-layer" aria-label="Values in effect">
      <header className="qd-rules-layer-head">
        <h3>In effect after saving</h3>
      </header>
      <table className="qd-rules-sources">
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Value</th>
            <th scope="col">From</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <SourceRow key={source.key} source={source} />
          ))}
        </tbody>
      </table>
    </section>
  );
};
