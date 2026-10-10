import { describe, expect, it } from 'vitest';
import {
  chatKeyAction,
  chatKeyEffect,
  chatMessage,
  IME_KEY_CODE,
  isComposing,
  type FieldText,
} from '../../src/primitives/index.js';

const key = (name: string, shiftKey = false, composing = false) =>
  chatKeyAction({ key: name, shiftKey, isComposing: composing });

const atEnd = (value: string): FieldText => ({
  value,
  selectionStart: value.length,
  selectionEnd: value.length,
});

const effect = (name: string, field: FieldText, shiftKey = false) =>
  chatKeyEffect({ key: name, shiftKey, isComposing: false }, field);

describe('chatKeyAction', () => {
  it('submits on Enter', () => {
    expect(key('Enter')).toBe('submit');
  });

  it('turns Shift+Enter into a newline', () => {
    expect(key('Enter', true)).toBe('newline');
  });

  it('indents on Tab and outdents on Shift+Tab', () => {
    expect(key('Tab')).toBe('indent');
    expect(key('Tab', true)).toBe('outdent');
  });

  it('ignores Enter and Tab while an IME is composing', () => {
    expect(key('Enter', false, true)).toBe('type');
    expect(key('Enter', true, true)).toBe('type');
    expect(key('Tab', false, true)).toBe('type');
  });

  it('lets every other key type', () => {
    expect(key('a')).toBe('type');
    expect(key('A', true)).toBe('type');
    expect(key('constructor')).toBe('type');
  });
});

describe('chatKeyEffect', () => {
  it('sends on Enter, even on a list line', () => {
    expect(effect('Enter', atEnd('plain'))).toEqual({ kind: 'submit' });
    expect(effect('Enter', atEnd('1. item'))).toEqual({ kind: 'submit' });
  });

  it('never sends while an IME is composing', () => {
    const composing = chatKeyEffect(
      { key: 'Enter', shiftKey: false, isComposing: true },
      atEnd('にほん'),
    );
    expect(composing).toEqual({ kind: 'native' });
  });

  it('continues a list on Shift+Enter', () => {
    expect(effect('Enter', atEnd('3. third'), true)).toEqual({
      kind: 'edit',
      edit: { start: 8, end: 8, text: '\n4. ' },
    });
  });

  it('leaves Shift+Enter outside a list to the textarea', () => {
    expect(effect('Enter', atEnd('plain'), true)).toEqual({ kind: 'native' });
  });

  it('indents and outdents a list line with Tab', () => {
    expect(effect('Tab', atEnd('- item'))).toEqual({
      kind: 'edit',
      edit: { start: 0, end: 6, text: '  - item' },
    });
    expect(effect('Tab', atEnd('  - item'), true)).toEqual({
      kind: 'edit',
      edit: { start: 0, end: 8, text: '- item' },
    });
  });

  it('leaves Tab off a list line to move focus', () => {
    expect(effect('Tab', atEnd('plain'))).toEqual({ kind: 'native' });
    expect(effect('Tab', atEnd('plain'), true)).toEqual({ kind: 'native' });
    expect(effect('Tab', atEnd('- top level'), true)).toEqual({
      kind: 'native',
    });
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
