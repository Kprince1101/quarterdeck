import type { JSX } from 'react';
import { useWording } from '../../deck/DeckProvider.js';
import { MACHINE_ONLY } from './constants.js';
import type { RulesWidgetView } from './use-rules-widget.js';

interface RulesPickersProps {
  view: RulesWidgetView;
}

export const RulesPickers = ({ view }: RulesPickersProps): JSX.Element => {
  const word = useWording();
  return (
    <div className="qd-rules-bar">
      <label>
        Rule
        <select value={view.ruleValue} onChange={view.handleRuleChange}>
          {view.names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {word('Project')}
        <select value={view.projectValue} onChange={view.handleProjectChange}>
          <option value={MACHINE_ONLY}>Machine only</option>
          {view.projects.map((project) => (
            <option key={project.slug} value={project.slug}>
              {project.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
};
