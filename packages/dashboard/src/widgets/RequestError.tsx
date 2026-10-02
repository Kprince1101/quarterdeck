import type { JSX } from 'react';

export interface RequestErrorProps {
  error: string | null;
}

export const RequestError = ({
  error,
}: RequestErrorProps): JSX.Element | null => {
  if (error === null) return null;
  return (
    <p className="qd-request-error" role="alert">
      {error}
    </p>
  );
};
