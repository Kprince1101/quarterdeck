import type { KeyboardEvent, ReactNode } from 'react';
import type { TabPanelView, TabView } from './use-tabs.js';
import './tab-bar.css';

const Tab = ({ tab }: { tab: TabView }) => (
  <button
    ref={tab.ref}
    type="button"
    role="tab"
    id={tab.domId}
    className="qd-tab"
    aria-selected={tab.isActive}
    aria-controls={tab.controls}
    tabIndex={tab.tabIndex}
    data-unread={tab.isUnread}
    onClick={tab.handleSelect}
  >
    <span className="qd-tab-label">{tab.label}</span>
    {tab.isUnread && (
      <span className="qd-tab-unread">
        <span className="qd-visually-hidden">unread</span>
      </span>
    )}
  </button>
);

export interface TabBarProps {
  label: string;
  tabs: readonly TabView[];
  onKeyDown: (event: KeyboardEvent) => void;
}

export const TabBar = ({ label, tabs, onKeyDown }: TabBarProps) => (
  <div
    className="qd-tab-bar"
    role="tablist"
    aria-label={label}
    onKeyDown={onKeyDown}
  >
    {tabs.map((tab) => (
      <Tab key={tab.id} tab={tab} />
    ))}
  </div>
);

export interface TabPanelProps {
  panel: TabPanelView;
  children?: ReactNode;
}

export const TabPanel = ({ panel, children }: TabPanelProps) => (
  <div
    className="qd-tab-panel"
    role="tabpanel"
    id={panel.id}
    aria-labelledby={panel.labelledBy}
    tabIndex={0}
  >
    {children}
  </div>
);
