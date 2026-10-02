import type { IntentErrorReply, IntentIssue } from '../intents/index.js';
import { hasErrorCode } from '../lib/errors.js';
import { ProjectOpenError } from '../store/index.js';

export class HttpError extends Error {
  readonly status: number;
  readonly issues: IntentIssue[] | undefined;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    message: string,
    extra: {
      issues?: IntentIssue[] | undefined;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.issues = extra.issues;
    this.headers = extra.headers ?? {};
  }

  toJSON(): IntentErrorReply {
    if (this.issues === undefined) return { error: this.message };
    return { error: this.message, issues: this.issues };
  }
}

export const badRequest = (message: string, issues?: IntentIssue[]) =>
  new HttpError(400, message, { issues });

export const notFound = (message: string) => new HttpError(404, message);

export const conflict = (message: string) => new HttpError(409, message);

export const asLockConflict = (err: unknown): unknown => {
  if (err instanceof ProjectOpenError) return conflict(err.message);
  if (err instanceof Error && hasErrorCode(err.cause, 'EEXIST')) {
    return conflict(err.message);
  }
  return err;
};
