export interface SendOptions {
  keepalive: boolean;
}

export interface LayoutWrite<Target> {
  key: string;
  send: (target: Target, options: SendOptions) => Promise<unknown>;
}

export interface LayoutWriterOptions {
  delayMs: number;
  onError: (err: unknown) => void;
}

export interface LayoutWriter<Target> {
  write: (write: LayoutWrite<Target>) => void;
  flush: (options?: SendOptions) => void;
  setTarget: (target: Target | null) => void;
  hasQueued: () => boolean;
  isEcho: (key: string) => boolean;
}

const IN_PAGE: SendOptions = { keepalive: false };

export const createLayoutWriter = <Target>({
  delayMs,
  onError,
}: LayoutWriterOptions): LayoutWriter<Target> => {
  const awaitingEcho: string[] = [];
  let queued: LayoutWrite<Target> | null = null;
  let target: Target | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;

  const sendOne = async (
    { key, send }: LayoutWrite<Target>,
    to: Target,
    options: SendOptions,
  ): Promise<void> => {
    awaitingEcho.push(key);
    try {
      await send(to, options);
    } catch (err) {
      awaitingEcho.splice(awaitingEcho.lastIndexOf(key), 1);
      onError(err);
    }
  };

  const drain = async (options: SendOptions): Promise<void> => {
    const next = queued;
    if (next === null || target === null) {
      sending = false;
      return;
    }
    queued = null;
    sending = true;
    await sendOne(next, target, options);
    return drain(IN_PAGE);
  };

  const sendBeforeLeaving = (options: SendOptions): void => {
    const next = queued;
    if (next === null || target === null) return;
    queued = null;
    void sendOne(next, target, options);
  };

  const flush = (options = IN_PAGE): void => {
    clearTimeout(timer);
    timer = undefined;
    if (!sending) void drain(options);
    else if (options.keepalive) sendBeforeLeaving(options);
  };

  return {
    write: (write) => {
      queued = write;
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    setTarget: (next) => {
      target = next;
      if (timer === undefined) flush();
    },
    hasQueued: () => queued !== null,
    isEcho: (key) => {
      const index = awaitingEcho.indexOf(key);
      if (index === -1) return false;
      awaitingEcho.splice(0, index + 1);
      return true;
    },
  };
};
