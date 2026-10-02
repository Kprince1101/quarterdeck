import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLayoutWriter,
  type LayoutWrite,
} from '../../src/layouts/layout-writer.js';

const DELAY = 100;

interface Gate {
  promise: Promise<void>;
  open: () => void;
  fail: (err: Error) => void;
}

const gate = (): Gate => {
  const opened: Partial<Pick<Gate, 'open' | 'fail'>> = {};
  const promise = new Promise<void>((resolve, reject) => {
    opened.open = () => resolve();
    opened.fail = reject;
  });
  return {
    promise,
    open: () => opened.open?.(),
    fail: (err) => opened.fail?.(err),
  };
};

describe('layout writer', () => {
  const sent: string[] = [];
  const gates = new Map<string, Gate>();
  const errors: unknown[] = [];

  const write = (key: string): LayoutWrite => ({
    key,
    send: () => {
      sent.push(key);
      const opened = gate();
      gates.set(key, opened);
      return opened.promise;
    },
  });

  const writer = () =>
    createLayoutWriter({ delayMs: DELAY, onError: (err) => errors.push(err) });

  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    errors.length = 0;
    gates.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the edits to settle and sends only the last one', async () => {
    const layouts = writer();
    layouts.write(write('a'));
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    layouts.write(write('b'));
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['b']);
  });

  it('sends one write at a time, then the newest one queued behind it', async () => {
    const layouts = writer();
    layouts.write(write('a'));
    await vi.advanceTimersByTimeAsync(DELAY);
    layouts.write(write('b'));
    layouts.write(write('c'));
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(sent).toEqual(['a']);
    gates.get('a')?.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['a', 'c']);
  });

  it('recognises the echo of its own writes, oldest first', async () => {
    const layouts = writer();
    layouts.write(write('a'));
    layouts.flush();
    gates.get('a')?.open();
    await vi.advanceTimersByTimeAsync(0);
    layouts.write(write('b'));
    layouts.flush();
    expect(layouts.isEcho('other')).toBe(false);
    expect(layouts.isEcho('b')).toBe(true);
    expect(layouts.isEcho('a')).toBe(false);
    expect(layouts.isEcho('b')).toBe(false);
  });

  it('forgets a write that failed and reports why', async () => {
    const layouts = writer();
    layouts.write(write('a'));
    layouts.flush();
    const refused = new Error('refused');
    gates.get('a')?.fail(refused);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([refused]);
    expect(layouts.isEcho('a')).toBe(false);
  });

  it('flushes a pending write at once', () => {
    const layouts = writer();
    layouts.write(write('a'));
    layouts.flush();
    expect(sent).toEqual(['a']);
    layouts.flush();
    expect(sent).toEqual(['a']);
  });
});
