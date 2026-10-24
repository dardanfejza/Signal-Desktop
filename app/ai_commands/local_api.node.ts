// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Loopback HTTP API exposing what this Signal Desktop client can see, plus the
// AI command presets. Bearer-token gated; bind to 127.0.0.1 unless you mean it.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import type {
  AiCommandSummary,
  AiComposeRequest,
  AiLevelScale,
  AiRunResult,
} from '../../ts/ai/types.std.ts';
import type { ConversationSummary, NormalizedMessage } from './context.std.ts';

export type LocalApiHandlers = Readonly<{
  listConversations: () => Promise<ReadonlyArray<ConversationSummary>>;
  getConversation: (id: string) => Promise<ConversationSummary | undefined>;
  getMessages: (
    id: string,
    limit: number
  ) => Promise<ReadonlyArray<NormalizedMessage>>;
  getActiveConversationId: () => string | null;
  listCommands: () => ReadonlyArray<AiCommandSummary>;
  getLevelScale: (
    commandId: string,
    conversationId: string
  ) => Promise<AiLevelScale>;
  runCommand: (
    commandId: string,
    conversationId: string,
    level: number | null
  ) => Promise<AiRunResult>;
  /** Returns false when no window is available to receive the request. */
  compose: (request: AiComposeRequest) => boolean;
}>;

export type LocalApiOptions = Readonly<{
  host: string;
  port: number;
  token: string;
  handlers: LocalApiHandlers;
  log: Readonly<{
    info: (message: string) => void;
    warn: (message: string) => void;
  }>;
}>;

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) {
    return false;
  }
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return url.searchParams.get('token');
}

async function readJsonBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Array<Buffer<ArrayBuffer>> = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array<ArrayBuffer>);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, 'body too large');
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, 'invalid JSON body');
  }
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw == null) {
    return DEFAULT_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new HttpError(400, 'limit must be a positive integer');
  }
  return Math.min(MAX_LIMIT, n);
}

function parseLevel(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new HttpError(400, 'level must be a positive integer');
  }
  return n;
}

async function resolveConversationId(
  handlers: LocalApiHandlers,
  requested: unknown
): Promise<string> {
  if (typeof requested === 'string' && requested.trim()) {
    return requested.trim();
  }
  const active = handlers.getActiveConversationId();
  if (!active) {
    throw new HttpError(409, 'no conversation is open and none was specified');
  }
  return active;
}

export type RouteResult = Readonly<{ status: number; body: unknown }>;

/** Exported for tests: routes one request without the HTTP plumbing. */
export async function route(
  method: string,
  url: URL,
  readBody: () => Promise<Record<string, unknown>>,
  handlers: LocalApiHandlers
): Promise<RouteResult> {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'v1') {
    throw new HttpError(404, 'not found');
  }
  const [, resource, id, sub] = segments;

  if (method === 'GET' && resource === 'health' && !id) {
    return { status: 200, body: { ok: true } };
  }

  if (resource === 'conversations') {
    if (method !== 'GET') {
      throw new HttpError(405, 'method not allowed');
    }
    if (!id) {
      return {
        status: 200,
        body: { conversations: await handlers.listConversations() },
      };
    }
    const conversation = await handlers.getConversation(id);
    if (!conversation) {
      throw new HttpError(404, 'conversation not found');
    }
    if (!sub) {
      return { status: 200, body: { conversation } };
    }
    if (sub === 'messages') {
      const messages = await handlers.getMessages(id, parseLimit(url));
      return { status: 200, body: { conversation, messages } };
    }
    throw new HttpError(404, 'not found');
  }

  if (resource === 'active' && !id) {
    if (method !== 'GET') {
      throw new HttpError(405, 'method not allowed');
    }
    const activeId = handlers.getActiveConversationId();
    if (!activeId) {
      return {
        status: 200,
        body: { conversationId: null, conversation: null, messages: [] },
      };
    }
    const [conversation, messages] = await Promise.all([
      handlers.getConversation(activeId),
      handlers.getMessages(activeId, parseLimit(url)),
    ]);
    return {
      status: 200,
      body: {
        conversationId: activeId,
        conversation: conversation ?? null,
        messages,
      },
    };
  }

  if (resource === 'commands') {
    if (!id) {
      if (method !== 'GET') {
        throw new HttpError(405, 'method not allowed');
      }
      return { status: 200, body: { commands: handlers.listCommands() } };
    }
    const command = handlers.listCommands().find(entry => entry.id === id);
    if (!command) {
      throw new HttpError(404, 'command not found');
    }
    if (sub === 'scale') {
      if (method !== 'GET') {
        throw new HttpError(405, 'method not allowed');
      }
      if (!command.levels) {
        throw new HttpError(400, 'command has no levels');
      }
      const conversationId = await resolveConversationId(
        handlers,
        url.searchParams.get('conversationId')
      );
      return {
        status: 200,
        body: await handlers.getLevelScale(command.id, conversationId),
      };
    }
    if (sub === 'run') {
      if (method !== 'POST') {
        throw new HttpError(405, 'method not allowed');
      }
      const body = await readBody();
      const conversationId = await resolveConversationId(
        handlers,
        body.conversationId
      );
      const level = parseLevel(body.level);
      if (level != null && (!command.levels || level > command.levels.count)) {
        throw new HttpError(400, 'level out of range for this command');
      }
      const result = await handlers.runCommand(
        command.id,
        conversationId,
        level
      );
      if (!result.ok) {
        return { status: 502, body: { ok: false, error: result.error } };
      }
      let composed = false;
      if (body.insert === true || body.send === true) {
        composed = handlers.compose({
          conversationId,
          text: result.text,
          send: body.send === true,
        });
      }
      return {
        status: 200,
        body: {
          ok: true,
          conversationId,
          level,
          text: result.text,
          durationMs: result.durationMs,
          composed,
        },
      };
    }
    if (!sub && method === 'GET') {
      return { status: 200, body: { command } };
    }
    throw new HttpError(404, 'not found');
  }

  if (resource === 'compose' && !id) {
    if (method !== 'POST') {
      throw new HttpError(405, 'method not allowed');
    }
    const body = await readBody();
    if (typeof body.text !== 'string' || !body.text.trim()) {
      throw new HttpError(400, 'text is required');
    }
    if (body.text.length > 20_000) {
      throw new HttpError(413, 'text too long');
    }
    const conversationId = await resolveConversationId(
      handlers,
      body.conversationId
    );
    const composed = handlers.compose({
      conversationId,
      text: body.text,
      send: body.send === true,
    });
    if (!composed) {
      throw new HttpError(503, 'no window available to compose into');
    }
    return {
      status: 202,
      body: { ok: true, conversationId, send: body.send === true },
    };
  }

  throw new HttpError(404, 'not found');
}

export function startLocalApi(options: LocalApiOptions): Promise<Server> {
  const { host, port, token, handlers, log } = options;

  const server = createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      if (!tokenMatches(presentedToken(req, url), token)) {
        throw new HttpError(401, 'missing or invalid token');
      }
      const result = await route(
        method,
        url,
        () => readJsonBody(req),
        handlers
      );
      sendJson(res, result.status, result.body);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, error: error.message });
        return;
      }
      log.warn(
        `local API ${method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      sendJson(res, 500, { ok: false, error: 'internal error' });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      log.info(`local API listening on http://${host}:${port}/v1`);
      resolve(server);
    });
  });
}
