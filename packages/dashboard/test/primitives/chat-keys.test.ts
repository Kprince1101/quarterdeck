import { describe, expect, it } from 'vitest';
import {
  chatKeyAction,
  chatMessage,
  IME_KEY_CODE,
  isComposing,
} from '../../src/primitives/index.js';

const key = (name: string, shiftKey = false, composing = false) =>
  chatKeyAction({ key: name, shiftKey, isComposing: composing });

describe('chatKeyAction', () => {
  it('submits on Enter', () => {
    expect(key('Enter')).toBe('submit');
  });

  it('leaves Shift+Enter to the textarea as a newline', () => {
    expect(key('Enter', true)).toBe('newline');
  });

  it('ignores Enter while an IME is composing', () => {
    expect(key('Enter', false, true)).toBe('type');
    expect(key('Enter', true, true)).toBe('type');
  });

  it('lets every other key type', () => {
    expect(key('a')).toBe('type');
    expect(key('A', true)).toBe('type');
    expect(key('Tab')).toBe('type');
  });
});

describe('chatMessage', () => {
  it('trims the draft and keeps inner newlines', () => {
    expect(chatMessage('  first\nsecond \n')).toBe('first\nsecond');
  });

  it('refuses a blank draft', () => {
    expect(chatMessage('')).toBeNull();
    expect(chatMessage(' \n\t ')).toBeNull();
  });
});

describe('isComposing', () => {
  it('reads isComposing off the native event', () => {
    expect(isComposing({ isComposing: true })).toBe(true);
    expect(isComposing({ isComposing: false })).toBe(false);
    expect(isComposing({})).toBe(false);
  });

  it('treats keyCode 229 as composing, as Safari sends it', () => {
    expect(isComposing({ isComposing: false, keyCode: IME_KEY_CODE })).toBe(
      true,
    );
    expect(isComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
