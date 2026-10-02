export interface RequestErrorProps {
  error: string | null;
}

export const RequestError = ({ error }: RequestErrorProps) => {
  if (error === null) return null;
  return (
    <p className="qd-request-error" role="alert">
      {error}
    </p>
  );
};
