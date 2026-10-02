import { RequestError } from '@agentclientprotocol/sdk';

export type AcpClientErrorCode =
  'aborted' | 'initialize_timeout' | 'resume_unsupported' | 'spawn_failed';

export class AcpClientError extends Error {
  readonly code: AcpClientErrorCode;

  constructor(message: string, code: AcpClientErrorCode) {
    super(message);
    this.name = 'AcpClientError';
    this.code = code;
  }
}

const AUTH_REQUIRED_CODE = RequestError.authRequired().code;

export const isAuthRequiredError = (err: unknown): boolean =>
  err instanceof RequestError && err.code === AUTH_REQUIRED_CODE;
