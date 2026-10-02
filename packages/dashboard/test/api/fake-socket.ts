import type { StreamMessage } from '@quarterdeck/server/stream-schema';

export class FakeSocket extends EventTarget {
  static opened: FakeSocket[] = [];

  readonly url: string;
  readonly protocols: string[] | undefined;
  closedWith: number | undefined;

  constructor(url: string, protocols?: string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
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
