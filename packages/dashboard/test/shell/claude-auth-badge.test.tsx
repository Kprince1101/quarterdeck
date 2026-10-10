// @vitest-environment happy-dom
import type { AuthReadResult } from '@quarterdeck/server/intents';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIntentClient } from '../../src/api/index.js';
import { DeckProvider } from '../../src/deck/DeckProvider.js';
import { ClaudeAuthBadge } from '../../src/shell/ClaudeAuthBadge.js';
import {
  AUTH_UNREADABLE_LABEL,
  claudeAuthView,
} from '../../src/shell/claude-auth-model.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import { render, type PageElement } from './page.js';

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

type Claude = AuthReadResult['claude'];

const SUBSCRIPTION: Claude = {
  mode: 'subscription',
  source: 'default',
  missing: [],
  keySource: null,
  gateway: false,
};

type Answer = Claude | { status: number; error: string };

const replyTo = (answer: Answer): Response => {
  if ('error' in answer) {
    return new Response(JSON.stringify({ error: answer.error }), {
      status: answer.status,
    });
  }
  return new Response(
    JSON.stringify({
      intent: 'auth.read',
      status: 'applied',
      id: null,
      result: { claude: answer },
    }),
    { status: 200 },
  );
};

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

const mount = async (answer: Answer) => {
  const sent: { url: string; body: unknown }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(replyTo(answer));
  });
  const page = render(
    <DeckProvider stream={stream} intents={createIntentClient({ fetch })}>
      <ClaudeAuthBadge />
    </DeckProvider>,
  );
  await flush();
  return { ...page, sent };
};

const badge = (container: PageElement) => {
  const element = container.querySelector('.qd-auth');
  if (element === null) return null;
  return {
    text: element.textContent,
    state: element.getAttribute('data-state'),
    title: element.getAttribute('title'),
  };
};

describe('Claude auth badge', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    FakeSocket.opened = [];
  });

  it('reads auth.read once and shows the mode', async () => {
    const { container, sent, unmount } = await mount(SUBSCRIPTION);
    expect(sent).toEqual([{ url: '/api/intents/auth.read', body: {} }]);
    expect(badge(container)).toEqual({
      text: 'Claude: subscription',
      state: 'ready',
      title: 'Claude auth mode subscription, the default',
    });
    expect(container.querySelector('button, input, select')).toBeNull();
    unmount();
  });

  it('says where the key comes from without showing it', async () => {
    const { container, unmount } = await mount({
      mode: 'api_key',
      source: 'file',
      missing: [],
      keySource: 'keychain',
      gateway: true,
    });
    expect(badge(container)).toEqual({
      text: 'Claude: API key',
      state: 'ready',
      title:
        'Claude auth mode api_key, set in ~/.quarterdeck/claude.json; ANTHROPIC_API_KEY from the Keychain; through ANTHROPIC_BASE_URL',
    });
    unmount();
  });

  it('marks a mode whose env is incomplete', async () => {
    const { container, unmount } = await mount({
      mode: 'vertex',
      source: 'env',
      missing: ['CLOUD_ML_REGION'],
      keySource: null,
      gateway: false,
    });
    expect(badge(container)).toEqual({
      text: 'Claude: Vertex',
      state: 'incomplete',
      title:
        'Claude auth mode vertex, set by QUARTERDECK_CLAUDE_AUTH; missing CLOUD_ML_REGION',
    });
    unmount();
  });

  it('says when the mode cannot be read', async () => {
    const { container, unmount } = await mount({
      status: 409,
      error: 'QUARTERDECK_CLAUDE_AUTH is "max"',
    });
    expect(badge(container)).toEqual({
      text: AUTH_UNREADABLE_LABEL,
      state: 'unreadable',
      title: 'QUARTERDECK_CLAUDE_AUTH is "max"',
    });
    unmount();
  });

  it('labels every mode', () => {
    expect(
      (['subscription', 'api_key', 'vertex'] as const).map(
        (mode) => claudeAuthView({ ...SUBSCRIPTION, mode }).label,
      ),
    ).toEqual(['Claude: subscription', 'Claude: API key', 'Claude: Vertex']);
  });
});
