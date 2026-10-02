export const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
};

export const hasErrorCode = (err: unknown, code: string): boolean =>
  err instanceof Error && 'code' in err && err.code === code;
