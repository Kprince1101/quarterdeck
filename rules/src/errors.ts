export const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
};

export const isMissingFile = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'ENOENT';

export class RulesError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'RulesError';
    this.path = path;
  }
}
