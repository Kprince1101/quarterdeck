export class KeepAwakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeepAwakeError';
  }
}
