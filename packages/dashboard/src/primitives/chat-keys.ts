import {
  continueList,
  indentList,
  type FieldText,
  type TextEdit,
} from './chat-input-lists.js';

export interface ChatKey {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}

export type ChatKeyAction =
  'submit' | 'newline' | 'indent' | 'outdent' | 'type';

export type ChatKeyEffect =
  { kind: 'submit' } | { kind: 'edit'; edit: TextEdit } | { kind: 'native' };

export const CHAT_INPUT_HINT =
  'Enter to send, Shift+Enter for a new line or list item';

const PLAIN_KEYS = new Map<string, ChatKeyAction>([
  ['Enter', 'submit'],
  ['Tab', 'indent'],
]);

const SHIFTED_KEYS = new Map<string, ChatKeyAction>([
  ['Enter', 'newline'],
  ['Tab', 'outdent'],
]);

export const chatKeyAction = ({
  key,
  shiftKey,
  isComposing,
}: ChatKey): ChatKeyAction => {
  if (isComposing) return 'type';
  if (shiftKey) return SHIFTED_KEYS.get(key) ?? 'type';
  return PLAIN_KEYS.get(key) ?? 'type';
};

type ListEditAction = Exclude<ChatKeyAction, 'submit' | 'type'>;

const LIST_EDITS: Record<
  ListEditAction,
  (field: FieldText) => TextEdit | null
> = {
  newline: continueList,
  indent: (field) => indentList(field, 'indent'),
  outdent: (field) => indentList(field, 'outdent'),
};

const NATIVE: ChatKeyEffect = { kind: 'native' };
const SUBMIT: ChatKeyEffect = { kind: 'submit' };

export const chatKeyEffect = (
  key: ChatKey,
  field: FieldText,
): ChatKeyEffect => {
  const action = chatKeyAction(key);
  if (action === 'type') return NATIVE;
  if (action === 'submit') return SUBMIT;
  const edit = LIST_EDITS[action](field);
  if (edit === null) return NATIVE;
  return { kind: 'edit', edit };
};

export const chatMessage = (draft: string): string | null => {
  const message = draft.trim();
  if (message === '') return null;
  return message;
};

export const IME_KEY_CODE = 229;

export const isComposing = (native: object): boolean => {
  if ('isComposing' in native && native.isComposing === true) return true;
  return 'keyCode' in native && native.keyCode === IME_KEY_CODE;
};
