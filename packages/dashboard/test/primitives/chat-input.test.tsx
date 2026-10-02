// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHAT_INPUT_HINT,
  ChatInput,
  IME_KEY_CODE,
  type ChatSubmit,
} from '../../src/primitives/index.js';
import {
  click,
  find,
  findAll,
  mount,
  press,
  typeInto,
  valueOf,
  type Mounted,
} from './dom.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const deferred = (): Deferred => {
  const settle: Omit<Deferred, 'promise'> = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<void>((resolve, reject) => {
    settle.resolve = resolve;
    settle.reject = reject;
  });
  return { promise, ...settle };
};

const mounted: Mounted[] = [];

const mountChat = (onSubmit: ChatSubmit, disabled?: boolean) => {
  const view = mount(
    <ChatInput
      label="Message the Planner"
      onSubmit={onSubmit}
      disabled={disabled}
    />,
  );
  mounted.push(view);
  const field = find(view.container, 'textarea');
  const send = find(view.container, 'button[type="submit"]');
  return { ...view, field, send };
};

describe('ChatInput', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    mounted.splice(0).forEach(({ unmount }) => unmount());
  });

  it('labels the box and says how to send', () => {
    const { container, field } = mountChat(vi.fn());
    expect(field.getAttribute('aria-label')).toBe('Message the Planner');
    expect(field.getAttribute('placeholder')).toBe(CHAT_INPUT_HINT);
    expect(find(container, 'form').getAttribute('aria-label')).toBe(
      'Message the Planner',
    );
  });

  it('sends the trimmed draft on Enter and clears the box', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { field } = mountChat(onSubmit);
    typeInto(field, '  ship it  ');
    const enter = await press(field, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('ship it');
    expect(valueOf(field)).toBe('');
  });

  it('leaves Shift+Enter to the textarea so it adds a newline', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { field } = mountChat(onSubmit);
    typeInto(field, 'first');
    const shiftEnter = await press(field, 'Enter', { shiftKey: true });
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    typeInto(field, 'first\nsecond');
    await press(field, 'Enter');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('first\nsecond');
  });

  it('does not send while an IME is composing', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { field } = mountChat(onSubmit);
    typeInto(field, 'にほん');
    const enter = await press(field, 'Enter', { isComposing: true });
    expect(enter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(valueOf(field)).toBe('にほん');
  });

  it('does not send on the Enter that confirms a Safari IME conversion', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { field } = mountChat(onSubmit);
    typeInto(field, 'にほん');
    const enter = await press(field, 'Enter', {
      isComposing: false,
      keyCode: IME_KEY_CODE,
    });
    expect(enter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends nothing for a blank draft', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { field, send } = mountChat(onSubmit);
    expect(send.hasAttribute('disabled')).toBe(true);
    typeInto(field, '  \n ');
    expect(send.hasAttribute('disabled')).toBe(true);
    await press(field, 'Enter');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends from the Send button too', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { field, send } = mountChat(onSubmit);
    typeInto(field, 'from the button');
    expect(send.hasAttribute('disabled')).toBe(false);
    await click(send);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('from the button');
    expect(valueOf(field)).toBe('');
  });

  it('holds the draft read-only until the send settles', async () => {
    const pending = deferred();
    const onSubmit = vi.fn<ChatSubmit>(() => pending.promise);
    const { container, field, send } = mountChat(onSubmit);
    typeInto(field, 'slow one');
    await press(field, 'Enter');
    expect(field.hasAttribute('readonly')).toBe(true);
    expect(find(container, 'form').getAttribute('aria-busy')).toBe('true');
    expect(send.hasAttribute('disabled')).toBe(true);

    await press(field, 'Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve();
    });
    expect(valueOf(field)).toBe('');
    expect(field.hasAttribute('readonly')).toBe(false);
  });

  it('keeps the draft and shows why when the send fails', async () => {
    const pending = deferred();
    const onSubmit = vi
      .fn<ChatSubmit>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce();
    const { container, field } = mountChat(onSubmit);
    typeInto(field, 'try me');
    await press(field, 'Enter');
    await act(async () => {
      pending.reject(new Error('planner is offline'));
    });
    expect(valueOf(field)).toBe('try me');
    expect(find(container, '[role="alert"]').textContent).toBe(
      'planner is offline',
    );
    expect(field.getAttribute('aria-invalid')).toBe('true');

    await press(field, 'Enter');
    expect(onSubmit).toHaveBeenLastCalledWith('try me');
    expect(findAll(container, '[role="alert"]')).toHaveLength(0);
    expect(valueOf(field)).toBe('');
  });

  it('does nothing while disabled', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { field, send } = mountChat(onSubmit, true);
    expect(field.hasAttribute('disabled')).toBe(true);
    expect(send.hasAttribute('disabled')).toBe(true);
    await press(field, 'Enter');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps a separate draft per box', async () => {
    const planner = vi.fn<ChatSubmit>();
    const driver = vi.fn<ChatSubmit>();
    const first = mountChat(planner);
    const second = mountChat(driver);
    typeInto(first.field, 'to the planner');
    typeInto(second.field, 'to the driver');
    await press(second.field, 'Enter');
    expect(driver).toHaveBeenCalledExactlyOnceWith('to the driver');
    expect(planner).not.toHaveBeenCalled();
    expect(valueOf(first.field)).toBe('to the planner');
  });
});
