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
  dom,
  type DomElement,
  type Mounted,
} from './dom.js';
import {
  installFakeEditor,
  placeCaret,
  type FakeEditor,
} from './fake-editor.js';

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
const editors: FakeEditor[] = [];

const editor = (): FakeEditor => {
  const installed = installFakeEditor();
  editors.push(installed);
  return installed;
};

const LINE_HEIGHT = 20;
const PADDING = 16;

const measureLines = (field: DomElement): void => {
  Object.defineProperty(field, 'scrollHeight', {
    configurable: true,
    get: () => PADDING + LINE_HEIGHT * valueOf(field).split('\n').length,
  });
};

const heightFor = (lines: number): string =>
  `${PADDING + LINE_HEIGHT * lines}px`;

const paste = async (
  field: DomElement,
  data: Record<string, string>,
): Promise<Event> => {
  const event = new (dom().Event)('paste', {
    bubbles: true,
    cancelable: true,
  }) as unknown as Event;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: Object.keys(data),
      getData: (format: string) => data[format] ?? '',
    },
  });
  await act(async () => {
    field.dispatchEvent(event as never);
  });
  return event;
};

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
    editors.splice(0).forEach(({ uninstall }) => uninstall());
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
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('ship it', []);
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
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('first\nsecond', []);
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
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('from the button', []);
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
    expect(onSubmit).toHaveBeenLastCalledWith('try me', []);
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

  it('continues a list on Shift+Enter through the native undo stack', async () => {
    const { commands } = editor();
    const onSubmit = vi.fn<ChatSubmit>();
    const { field } = mountChat(onSubmit);
    typeInto(field, '3. third');
    const shiftEnter = await press(field, 'Enter', { shiftKey: true });
    expect(shiftEnter.defaultPrevented).toBe(true);
    expect(commands).toEqual(['insertText']);
    expect(valueOf(field)).toBe('3. third\n4. ');
    expect(onSubmit).not.toHaveBeenCalled();

    typeInto(field, '3. third\n4. fourth');
    await press(field, 'Enter');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('3. third\n4. fourth', []);
  });

  it('ends a list when Shift+Enter lands on an empty item', async () => {
    editor();
    const { field } = mountChat(vi.fn());
    typeInto(field, '- one\n- ');
    await press(field, 'Enter', { shiftKey: true });
    expect(valueOf(field)).toBe('- one\n');
  });

  it('undo brings back the text from before a list continuation', async () => {
    const { undo } = editor();
    const onSubmit = vi.fn<ChatSubmit>();
    const { field } = mountChat(onSubmit);
    typeInto(field, '- [x] done');
    await press(field, 'Enter', { shiftKey: true });
    expect(valueOf(field)).toBe('- [x] done\n- [ ] ');

    const cmdZ = await press(field, 'z', { metaKey: true });
    expect(cmdZ.defaultPrevented).toBe(false);
    undo();
    expect(valueOf(field)).toBe('- [x] done');

    await press(field, 'Enter');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('- [x] done', []);
  });

  it('indents and outdents a list line with Tab and Shift+Tab', async () => {
    editor();
    const { field } = mountChat(vi.fn());
    typeInto(field, '- one\n- two');
    const tab = await press(field, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(valueOf(field)).toBe('- one\n  - two');

    const shiftTab = await press(field, 'Tab', { shiftKey: true });
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(valueOf(field)).toBe('- one\n- two');

    placeCaret(field, 2);
    const atTop = await press(field, 'Tab', { shiftKey: true });
    expect(atTop.defaultPrevented).toBe(false);
    expect(valueOf(field)).toBe('- one\n- two');
  });

  it('leaves Tab off a list line to move focus', async () => {
    editor();
    const { field } = mountChat(vi.fn());
    typeInto(field, 'plain words');
    const tab = await press(field, 'Tab');
    expect(tab.defaultPrevented).toBe(false);
    expect(valueOf(field)).toBe('plain words');
  });

  it('grows with its content and shrinks back after sending', async () => {
    const { field } = mountChat(vi.fn());
    measureLines(field);
    typeInto(field, 'one line');
    expect(field.style.height).toBe(heightFor(1));

    typeInto(field, 'one\ntwo\nthree');
    expect(field.style.height).toBe(heightFor(3));

    await press(field, 'Enter');
    expect(valueOf(field)).toBe('');
    expect(field.style.height).toBe(heightFor(1));
  });

  it('pastes rich HTML as plain text, undoably', async () => {
    const { undo } = editor();
    const { field } = mountChat(vi.fn());
    typeInto(field, 'see: ');
    const pasted = await paste(field, {
      'text/html': '<p>first <b>bold</b></p><ul><li>a</li><li>b</li></ul>',
    });
    expect(pasted.defaultPrevented).toBe(true);
    expect(valueOf(field)).toBe('see: first bold\n\na\nb');

    undo();
    expect(valueOf(field)).toBe('see: ');
  });

  it('pastes plain text over the selection', async () => {
    editor();
    const { field } = mountChat(vi.fn());
    typeInto(field, 'swap THIS out');
    placeCaret(field, 5, 9);
    await paste(field, {
      'text/plain': 'that\r\nline',
      'text/html': '<i>x</i>',
    });
    expect(valueOf(field)).toBe('swap that\nline out');
  });

  it('leaves a paste with no text in it to the browser', async () => {
    editor();
    const { field } = mountChat(vi.fn());
    const pasted = await paste(field, { Files: '' });
    expect(pasted.defaultPrevented).toBe(false);
    expect(valueOf(field)).toBe('');
  });

  it('keeps a separate draft per box', async () => {
    const planner = vi.fn<ChatSubmit>();
    const driver = vi.fn<ChatSubmit>();
    const first = mountChat(planner);
    const second = mountChat(driver);
    typeInto(first.field, 'to the planner');
    typeInto(second.field, 'to the driver');
    await press(second.field, 'Enter');
    expect(driver).toHaveBeenCalledExactlyOnceWith('to the driver', []);
    expect(planner).not.toHaveBeenCalled();
    expect(valueOf(first.field)).toBe('to the planner');
  });
});
