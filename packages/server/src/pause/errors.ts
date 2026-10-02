import type { PauseSubject } from './gate.js';

export type DropReason = 'aborted' | 'closed' | 'archived' | 'finished';

export class PauseDroppedError extends Error {
  readonly subject: PauseSubject;
  readonly reason: DropReason;

  constructor(subject: PauseSubject, reason: DropReason) {
    super(
      `Held ${subject.operation} "${subject.label}" was dropped: ${reason}`,
    );
    this.name = 'PauseDroppedError';
    this.subject = subject;
    this.reason = reason;
  }
}
