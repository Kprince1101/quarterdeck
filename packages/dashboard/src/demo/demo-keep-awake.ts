import type {
  KeepAwakeRequest,
  KeepAwakeResult,
} from '@quarterdeck/server/intents';
import type { StreamMessage } from '@quarterdeck/server/stream-schema';
import { DEMO_KEEP_AWAKE_OFF, type DemoStore } from './demo-store.js';

export const DEMO_VOYAGE_ENDED = 'voyage.ended';

const MS_PER_MINUTE = 60 * 1000;

export interface DemoKeepAwake {
  start: (request: KeepAwakeRequest) => KeepAwakeResult;
  stop: () => KeepAwakeResult;
}

export interface DemoKeepAwakeOptions {
  store: DemoStore;
  later: (ms: number, work: () => void) => void;
}

const isVoyageEnd = (message: StreamMessage): boolean =>
  message.type === 'event' && message.event.kind === DEMO_VOYAGE_ENDED;

export const createDemoKeepAwake = ({
  store,
  later,
}: DemoKeepAwakeOptions): DemoKeepAwake => {
  let hold = 0;

  const set = (next: typeof DEMO_KEEP_AWAKE_OFF): KeepAwakeResult => {
    store.setKeepAwake(next);
    return { keepAwake: next };
  };

  const stop = (): KeepAwakeResult => {
    hold += 1;
    return set(DEMO_KEEP_AWAKE_OFF);
  };

  store.connect(store.events().at(-1)?.id ?? 0, (message) => {
    if (isVoyageEnd(message) && store.keepAwake().mode === 'untilVoyageEnds') {
      stop();
    }
  });

  const start = (request: KeepAwakeRequest): KeepAwakeResult => {
    hold += 1;
    if (!('minutes' in request)) {
      return set({
        ...DEMO_KEEP_AWAKE_OFF,
        on: true,
        mode: 'untilVoyageEnds',
      });
    }
    const mine = hold;
    const ms = request.minutes * MS_PER_MINUTE;
    later(ms, () => {
      if (hold === mine) stop();
    });
    return set({
      ...DEMO_KEEP_AWAKE_OFF,
      on: true,
      mode: 'duration',
      expiresAt: new Date(Date.parse(store.now()) + ms).toISOString(),
    });
  };

  return { start, stop };
};
