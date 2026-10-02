import { useEffect, useState } from 'react';
import { getErrorMessage } from '../../lib/errors.js';

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
}

export type QueryLoader<T> = () => Promise<T>;

const IDLE: QueryState<never> = { data: null, error: null, isLoading: false };

export const useIntentQuery = <T>(
  load: QueryLoader<T> | null,
  version: number | string,
): QueryState<T> => {
  const [state, setState] = useState<QueryState<T>>(IDLE);
  useEffect(() => {
    if (load === null) return undefined;
    let current = true;
    setState((previous) => ({ ...previous, isLoading: true }));
    load().then(
      (data) => {
        if (current) setState({ data, error: null, isLoading: false });
      },
      (err: unknown) => {
        if (current) {
          setState({
            data: null,
            error: getErrorMessage(err),
            isLoading: false,
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [load, version]);
  return state;
};
