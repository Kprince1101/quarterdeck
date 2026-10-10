import { useState } from 'react';

export interface WorkspaceNoticeView {
  notice: string | null;
  handleDismiss: () => void;
}

const shownNotice = (
  notice: string | null,
  dismissed: string | null,
): string | null => {
  if (notice === dismissed) return null;
  return notice;
};

export const useWorkspaceNotice = (
  notice: string | null,
): WorkspaceNoticeView => {
  const [dismissed, setDismissed] = useState<string | null>(null);
  return {
    notice: shownNotice(notice, dismissed),
    handleDismiss: () => setDismissed(notice),
  };
};
