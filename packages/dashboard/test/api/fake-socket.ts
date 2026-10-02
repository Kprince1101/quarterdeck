import type { StreamMessage } from '@quarterdeck/server/stream-schema';

export class FakeSocket extends EventTarget {
  static opened: FakeSocket[] = [];

  readonly url: string;
  closedWith: number | undefined;

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.opened.push(this);
  }

  close(code?: number): void {
    this.closedWith = code;
  }

  deliver(message: StreamMessage): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(message) }),
    );
  }

  deliverRaw(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  fail(): void {
    this.dispatchEvent(new Event('error'));
  }

  drop(code: number): void {
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }
}

export const FAKE_WEBSOCKET = FakeSocket as unknown as typeof WebSocket;
