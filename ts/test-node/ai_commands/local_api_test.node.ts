// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  route,
  type LocalApiHandlers,
} from '../../../app/ai_commands/local_api.node.ts';
import type { AiComposeRequest } from '../../../ts/ai/types.std.ts';

function makeHandlers(
  overrides: Partial<LocalApiHandlers> = {}
): LocalApiHandlers & { composed: Array<AiComposeRequest> } {
  const composed: Array<AiComposeRequest> = [];
  const conversation = {
    id: 'conv-1',
    type: 'group' as const,
    title: 'Dota squad',
    isGroup: true,
    memberCount: 3,
    members: ['Me', 'Sean', 'Artan'],
    activeAt: 1,
    unreadCount: 0,
    isArchived: false,
  };
  return {
    composed,
    listConversations: async () => [conversation],
    getConversation: async id => (id === 'conv-1' ? conversation : undefined),
    getMessages: async (_id, limit) =>
      Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
        id: `m${i}`,
        conversationId: 'conv-1',
        timestamp: i,
        receivedAt: i,
        direction: 'incoming' as const,
        senderId: null,
        senderName: 'Sean',
        body: `hi ${i}`,
        attachments: [],
        quoteText: null,
        reactions: [],
      })),
    getActiveConversationId: () => 'conv-1',
    listCommands: () => [
      {
        id: 'insult-sean',
        label: 'Insult Sean',
        symbol: null,
        pinned: true,
        levels: { count: 10, default: 5, evolving: true, describe: 'd' },
        autoSend: false,
      },
      {
        id: 'reply',
        label: 'Reply',
        symbol: null,
        pinned: false,
        levels: null,
        autoSend: false,
      },
    ],
    getLevelScale: async (commandId, conversationId) => ({
      commandId,
      conversationId,
      levels: [],
      generatedAt: 0,
      source: 'fallback' as const,
    }),
    runCommand: async (commandId, conversationId, level) => ({
      ok: true as const,
      text: `${commandId}:${conversationId}:${level ?? 'none'}`,
      durationMs: 1,
    }),
    compose: request => {
      composed.push(request);
      return true;
    },
    ...overrides,
  };
}

async function call(
  handlers: LocalApiHandlers,
  method: string,
  path: string,
  body: Record<string, unknown> = {}
) {
  return route(
    method,
    new URL(path, 'http://127.0.0.1'),
    async () => body,
    handlers
  );
}

async function expectStatus(
  promise: Promise<unknown>,
  status: number
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual((error as { status?: number }).status, status);
    return;
  }
  assert.fail(`expected HTTP ${status}`);
}

describe('ai_commands/local_api route', () => {
  it('lists and reads conversations and messages', async () => {
    const handlers = makeHandlers();
    const list = await call(handlers, 'GET', '/v1/conversations');
    assert.strictEqual(list.status, 200);
    assert.lengthOf(
      (list.body as { conversations: Array<unknown> }).conversations,
      1
    );

    const messages = await call(
      handlers,
      'GET',
      '/v1/conversations/conv-1/messages?limit=2'
    );
    assert.strictEqual(messages.status, 200);
    assert.lengthOf(
      (messages.body as { messages: Array<unknown> }).messages,
      2
    );

    await expectStatus(call(handlers, 'GET', '/v1/conversations/nope'), 404);
    await expectStatus(
      call(handlers, 'GET', '/v1/conversations/conv-1/messages?limit=0'),
      400
    );
    await expectStatus(call(handlers, 'POST', '/v1/conversations'), 405);
  });

  it('returns the active conversation with messages', async () => {
    const handlers = makeHandlers();
    const result = await call(handlers, 'GET', '/v1/active');
    assert.strictEqual(result.status, 200);
    const body = result.body as {
      conversationId: string;
      messages: Array<unknown>;
    };
    assert.strictEqual(body.conversationId, 'conv-1');
    assert.lengthOf(body.messages, 3);

    const idle = makeHandlers({ getActiveConversationId: () => null });
    const none = await call(idle, 'GET', '/v1/active');
    assert.deepStrictEqual(none.body, {
      conversationId: null,
      conversation: null,
      messages: [],
    });
  });

  it('runs commands against the active conversation and validates levels', async () => {
    const handlers = makeHandlers();
    const run = await call(handlers, 'POST', '/v1/commands/insult-sean/run', {
      level: 7,
    });
    assert.strictEqual(run.status, 200);
    assert.strictEqual(
      (run.body as { text: string }).text,
      'insult-sean:conv-1:7'
    );
    assert.isFalse((run.body as { composed: boolean }).composed);
    assert.lengthOf(handlers.composed, 0);

    await expectStatus(
      call(handlers, 'POST', '/v1/commands/insult-sean/run', { level: 11 }),
      400
    );
    await expectStatus(
      call(handlers, 'POST', '/v1/commands/reply/run', { level: 1 }),
      400
    );
    await expectStatus(call(handlers, 'POST', '/v1/commands/unknown/run'), 404);
    await expectStatus(call(handlers, 'GET', '/v1/commands/reply/scale'), 400);

    const inserted = await call(handlers, 'POST', '/v1/commands/reply/run', {
      conversationId: 'conv-1',
      insert: true,
    });
    assert.isTrue((inserted.body as { composed: boolean }).composed);
    assert.deepStrictEqual(handlers.composed, [
      { conversationId: 'conv-1', text: 'reply:conv-1:none', send: false },
    ]);
  });

  it('surfaces model failures as 502 and refuses when no chat is open', async () => {
    const failing = makeHandlers({
      runCommand: async () => ({ ok: false as const, error: 'boom' }),
    });
    const result = await call(failing, 'POST', '/v1/commands/reply/run');
    assert.strictEqual(result.status, 502);

    const idle = makeHandlers({ getActiveConversationId: () => null });
    await expectStatus(call(idle, 'POST', '/v1/commands/reply/run'), 409);
  });

  it('composes text into the open chat', async () => {
    const handlers = makeHandlers();
    const result = await call(handlers, 'POST', '/v1/compose', {
      text: 'hello',
      send: true,
    });
    assert.strictEqual(result.status, 202);
    assert.deepStrictEqual(handlers.composed, [
      { conversationId: 'conv-1', text: 'hello', send: true },
    ]);
    await expectStatus(
      call(handlers, 'POST', '/v1/compose', { text: '   ' }),
      400
    );
    await expectStatus(call(handlers, 'GET', '/v2/anything'), 404);
  });
});
