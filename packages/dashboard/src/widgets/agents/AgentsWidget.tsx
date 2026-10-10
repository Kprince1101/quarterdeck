import type { JSX } from 'react';
import { useWorkspaceMode } from '../../deck/DeckProvider.js';
import { defineWidget } from '../registry.js';
import { AgentCard } from './AgentCard.js';
import { useAgentsWidget } from './use-agents-widget.js';
import './agents.css';

export const AgentsWidget = (): JSX.Element => {
  const { agents, showProject, isEmpty } = useAgentsWidget();
  const isMulti = useWorkspaceMode() === 'multi';
  if (isEmpty) return <p className="qd-empty">No agents yet.</p>;
  return (
    <ol className="qd-agents">
      {agents.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          showProject={isMulti && showProject}
        />
      ))}
    </ol>
  );
};

export default defineWidget({
  type: 'agents',
  title: 'Agents',
  component: AgentsWidget,
  size: { w: 4, h: 8 },
  minSize: { w: 3, h: 4 },
});
