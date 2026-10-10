import type { JSX } from 'react';
import type { WorkspaceMode } from '../../api/index.js';
import { useWorkspaceMode } from '../../deck/DeckProvider.js';
import { ChatInput } from '../../primitives/index.js';
import { defineWidget } from '../registry.js';
import type {
  ChatMessage,
  ConversationEntry,
  ProjectChoice,
} from './planner-model.js';
import './planner.css';
import { ProposalCard } from './ProposalCard.js';
import { usePlannerWidget } from './use-planner-widget.js';

interface MessageItemProps {
  message: ChatMessage;
}

const MessageItem = ({ message }: MessageItemProps) => (
  <div className="qd-planner-message" data-author={message.author}>
    <span className="qd-planner-author">{message.authorLabel}</span>
    <p>{message.text}</p>
  </div>
);

interface ConversationLogProps {
  entries: ConversationEntry[];
  home: string;
  projects: ProjectChoice[];
}

const ConversationLog = ({ entries, home, projects }: ConversationLogProps) => (
  <ol className="qd-planner-log" aria-label="Conversation">
    {entries.map((entry) => (
      <li key={entry.key}>
        {entry.message && <MessageItem message={entry.message} />}
        {entry.proposal && (
          <ProposalCard
            proposal={entry.proposal}
            home={home}
            projects={projects}
          />
        )}
      </li>
    ))}
  </ol>
);

interface ConversationBodyProps extends ConversationLogProps {
  hasProject: boolean;
  isEmpty: boolean;
}

const NO_HOME: Record<WorkspaceMode, string> = {
  multi: 'No project yet. Create one to plan.',
  single: 'No repository yet. Add one with init to plan.',
};

const ConversationBody = ({
  hasProject,
  isEmpty,
  ...log
}: ConversationBodyProps) => {
  const mode = useWorkspaceMode();
  if (!hasProject) {
    return <p className="qd-empty">{NO_HOME[mode]}</p>;
  }
  if (isEmpty) {
    return (
      <p className="qd-empty">
        No conversation yet. Tell the Planner what to build.
      </p>
    );
  }
  return <ConversationLog {...log} />;
};

export const PlannerWidget = (): JSX.Element => {
  const view = usePlannerWidget();
  return (
    <div className="qd-planner">
      <div className="qd-planner-bar">
        <button
          type="button"
          className="qd-planner-new"
          disabled={view.isNewDisabled}
          onClick={view.handleNew}
        >
          New conversation
        </button>
      </div>
      {view.hasNewError && (
        <p className="qd-planner-error" role="alert">
          {view.newError}
        </p>
      )}
      <ConversationBody
        hasProject={view.hasProject}
        isEmpty={view.isEmpty}
        entries={view.entries}
        home={view.homeSlug}
        projects={view.projectOptions}
      />
      <ChatInput
        label="Message the Planner"
        disabled={view.isChatDisabled}
        onSubmit={view.handleSend}
      />
    </div>
  );
};

export default defineWidget({
  type: 'planner',
  title: 'Planner',
  component: PlannerWidget,
  size: { w: 6, h: 12 },
  minSize: { w: 3, h: 4 },
});
