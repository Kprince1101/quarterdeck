export type AcpClientErrorCode = 'resume_unsupported' | 'spawn_failed';

export class AcpClientError extends Error {
  readonly code: AcpClientErrorCode;

  constructor(message: string, code: AcpClientErrorCode) {
    super(message);
    this.name = 'AcpClientError';
    this.code = code;
  }
}
