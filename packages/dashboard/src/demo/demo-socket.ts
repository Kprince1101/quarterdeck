import { STREAM_AFTER_PARAM } from '@quarterdeck/server/stream-schema';
import type { DemoStore } from './demo-store.js';

const afterOf = (url: string): number | null => {
  const after = new URL(url).searchParams.get(STREAM_AFTER_PARAM);
  if (after === null) return null;
  const cursor = Number(after);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return null;
  return cursor;
};

export const demoWebSocket = (store: DemoStore): typeof WebSocket => {
  class DemoSocket extends EventTarget {
    readonly url: string;
    private disconnect: (() => void) | undefined;
    private opening: ReturnType<typeof setTimeout> | undefined;

    constructor(url: string) {
      super();
      this.url = url;
      this.opening = setTimeout(() => {
        this.opening = undefined;
        this.disconnect = store.connect(afterOf(url), (message) => {
          this.dispatchEvent(
            new MessageEvent('message', { data: JSON.stringify(message) }),
          );
        });
      }, 0);
    }

    close(): void {
      clearTimeout(this.opening);
      this.disconnect?.();
      this.disconnect = undefined;
    }
  }
  return DemoSocket as unknown as typeof WebSocket;
};
