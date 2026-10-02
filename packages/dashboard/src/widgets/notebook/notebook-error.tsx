export interface NotebookErrorProps {
  error: string | null;
}

export const NotebookError = ({ error }: NotebookErrorProps) => {
  if (error === null) return null;
  return (
    <p className="qd-notebook-error" role="alert">
      {error}
    </p>
  );
};
