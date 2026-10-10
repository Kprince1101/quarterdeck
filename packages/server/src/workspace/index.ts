export {
  confirmationList,
  describeRepository,
  detectWorkspace,
  slugFromFolder,
  type DetectOptions,
  type WorkspaceDetection,
} from './detect.js';
export {
  DEFAULT_WORKSPACE_MODE,
  createWorkspaces,
  workspaceMode,
  type WorkspaceListener,
  type WorkspaceSeedProject,
  type WorkspaceUpdate,
  type Workspaces,
} from './feed.js';
export {
  WORKSPACE_FILE,
  readWorkspace,
  workspacePath,
  writeWorkspace,
  type WorkspaceRecord,
} from './file.js';
export {
  MULTI_ONLY,
  SINGLE_ONLY,
  byMode,
  multiOnly,
  repositoryWording,
  singleOnly,
  switchNotice,
  workspaceWording,
} from './wording.js';
export {
  commonParent,
  mergeWorkspace,
  withoutProjects,
  type WorkspaceAddition,
  type WorkspaceChange,
} from './merge.js';
