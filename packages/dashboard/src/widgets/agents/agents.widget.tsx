import { defineWidget } from '../registry.js';
import { AgentCard } from './agent-card.js';
import { useAgentsWidget } from './use-agents-widget.js';
import './agents.css';

export const AgentsWidget = () => {
  const { agents, showProject, isEmpty } = useAgentsWidget();
  if (isEmpty) return <p className="qd-empty">No agents yet.</p>;
  return (
    <ol className="qd-agents">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} showProject={showProject} />
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
