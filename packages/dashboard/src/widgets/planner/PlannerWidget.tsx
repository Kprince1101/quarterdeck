import type { ChangeEvent, JSX } from 'react';
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

interface ProjectPickerProps {
  value: string;
  options: ProjectChoice[];
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}

const ProjectPicker = ({ value, options, onChange }: ProjectPickerProps) => (
  <label className="qd-planner-project">
    <span>Project</span>
    <select value={value} onChange={onChange}>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

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
  project: string;
}

const ConversationLog = ({ entries, project }: ConversationLogProps) => (
  <ol className="qd-planner-log" aria-label="Conversation">
    {entries.map((entry) => (
      <li key={entry.key}>
        {entry.message && <MessageItem message={entry.message} />}
        {entry.proposal && (
          <ProposalCard proposal={entry.proposal} project={project} />
        )}
      </li>
    ))}
  </ol>
);

interface ConversationBodyProps extends ConversationLogProps {
  hasProject: boolean;
  isEmpty: boolean;
}

const ConversationBody = ({
  hasProject,
  isEmpty,
  entries,
  project,
}: ConversationBodyProps) => {
  if (!hasProject) {
    return <p className="qd-empty">No project yet. Create one to plan.</p>;
  }
  if (isEmpty) {
    return (
      <p className="qd-empty">
        No conversation yet. Tell the Planner what to build.
      </p>
    );
  }
  return <ConversationLog entries={entries} project={project} />;
};

export const PlannerWidget = (): JSX.Element => {
  const view = usePlannerWidget();
  return (
    <div className="qd-planner">
      <div className="qd-planner-bar">
        <ProjectPicker
          value={view.projectValue}
          options={view.projectOptions}
          onChange={view.handleProjectChange}
        />
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
        project={view.projectSlug}
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
