// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { BrowserWindow } from 'electron';
import { ipcMain, shell } from 'electron';
import type { Server } from 'node:http';

import { createLogger } from '../../ts/logging/log.std.ts';
import type { MainSQL } from '../../ts/sql/main.main.ts';
import {
  AI_IPC,
  type AiCommandsClientConfig,
  type AiComposeRequest,
  type AiLevelScale,
  type AiRunResult,
} from '../../ts/ai/types.std.ts';
import {
  getConfigPath,
  loadConfig,
  toClientConfig,
  toCommandSummary,
  watchConfig,
  type AiCommandDefinition,
  type LoadedConfig,
} from './config.node.ts';
import { ConversationContext } from './context.std.ts';
import { chatCompletion, LlmError } from './llm.std.ts';
import { startLocalApi } from './local_api.node.ts';
import {
  buildCommandPrompt,
  buildScalePrompt,
  buildTranscript,
  cleanReply,
  fallbackScale,
  parseScale,
} from './prompts.std.ts';

const log = createLogger('ai-commands');

export type AiCommandsServiceOptions = Readonly<{
  sql: MainSQL;
  userDataPath: string;
  getMainWindow: () => BrowserWindow | undefined;
}>;

type ScaleCacheEntry = Readonly<{
  scale: AiLevelScale;
  lastMessageId: string | null;
}>;

const SCALE_CACHE_MAX = 100;

export class AiCommandsService {
  readonly #getMainWindow: () => BrowserWindow | undefined;

  readonly #configPath: string;

  readonly #context: ConversationContext;

  #loaded: LoadedConfig;

  #server: Server | undefined;

  #serverKey: string | undefined;

  #activeConversationId: string | null = null;

  readonly #scaleCache = new Map<string, ScaleCacheEntry>();

  readonly #scaleInFlight = new Map<string, Promise<AiLevelScale>>();

  #stopWatching: (() => void) | undefined;

  constructor(options: AiCommandsServiceOptions) {
    this.#getMainWindow = options.getMainWindow;
    this.#configPath = getConfigPath(options.userDataPath);
    this.#context = new ConversationContext(options.sql);
    this.#loaded = loadConfig(this.#configPath);
    this.#reportLoad();
  }

  get clientConfig(): AiCommandsClientConfig {
    return toClientConfig(this.#loaded);
  }

  async start(): Promise<void> {
    this.#registerIpc();
    await this.#syncServer();
    this.#stopWatching = watchConfig(this.#configPath, () => {
      void this.reload();
    });
  }

  async stop(): Promise<void> {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
    await this.#closeServer();
  }

  async reload(): Promise<void> {
    this.#loaded = loadConfig(this.#configPath);
    this.#scaleCache.clear();
    this.#reportLoad();
    await this.#syncServer();
    this.#getMainWindow()?.webContents.send(
      AI_IPC.configChanged,
      this.clientConfig
    );
  }

  setActiveConversation(conversationId: string | null): void {
    this.#activeConversationId = conversationId;
  }

  #reportLoad(): void {
    const { config, created, warnings } = this.#loaded;
    log.info(
      `config loaded (${created ? 'created defaults' : 'existing'}): enabled=${config.enabled} commands=${config.commands.length} localApi=${config.localApi.enabled ? `${config.localApi.host}:${config.localApi.port}` : 'off'} llm=${config.llm.label}@${config.llm.baseUrl} model=${config.llm.model}`
    );
    for (const warning of warnings) {
      log.warn(`config: ${warning}`);
    }
  }

  async #syncServer(): Promise<void> {
    const { localApi, enabled } = this.#loaded.config;
    const wanted = enabled && localApi.enabled;
    const key = `${localApi.host}:${localApi.port}:${localApi.token}`;
    if (!wanted) {
      await this.#closeServer();
      return;
    }
    if (this.#server && this.#serverKey === key) {
      return;
    }
    await this.#closeServer();
    try {
      this.#server = await startLocalApi({
        host: localApi.host,
        port: localApi.port,
        token: localApi.token,
        log,
        handlers: {
          listConversations: () => this.#context.listConversations(),
          getConversation: id => this.#context.getConversation(id),
          getMessages: (id, limit) =>
            this.#context.getRecentMessages(id, limit),
          getActiveConversationId: () => this.#activeConversationId,
          listCommands: () =>
            this.#loaded.config.commands.map(toCommandSummary),
          getLevelScale: (commandId, conversationId) =>
            this.getLevelScale(commandId, conversationId),
          runCommand: (commandId, conversationId, level) =>
            this.runCommand(commandId, conversationId, level),
          compose: request => this.compose(request),
        },
      });
      this.#serverKey = key;
    } catch (error) {
      log.error(
        `local API failed to start on ${localApi.host}:${localApi.port}: ${error instanceof Error ? error.message : String(error)}`
      );
      this.#server = undefined;
      this.#serverKey = undefined;
    }
  }

  async #closeServer(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#serverKey = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    log.info('local API stopped');
  }

  compose(request: AiComposeRequest): boolean {
    const window = this.#getMainWindow();
    if (!window || window.isDestroyed()) {
      return false;
    }
    window.webContents.send(AI_IPC.compose, request);
    log.info(
      `compose request forwarded (chars=${request.text.length}, send=${request.send})`
    );
    return true;
  }

  #findCommand(commandId: string): AiCommandDefinition | undefined {
    return this.#loaded.config.commands.find(
      command => command.id === commandId
    );
  }

  async #transcriptFor(
    command: AiCommandDefinition,
    conversationId: string
  ): Promise<{
    transcript: string;
    title: string;
    isGroup: boolean;
    myName: string;
    lastMessageId: string | null;
    included: number;
  }> {
    const { context } = this.#loaded.config;
    const count = command.contextMessages ?? context.messageCount;
    const [conversation, messages, myName] = await Promise.all([
      this.#context.getConversation(conversationId),
      this.#context.getRecentMessages(conversationId, count),
      this.#context.getMyName(),
    ]);
    const built = buildTranscript(messages, { maxChars: context.maxChars });
    return {
      transcript: built.text,
      title: conversation?.title ?? 'this chat',
      isGroup: conversation?.isGroup ?? false,
      myName,
      lastMessageId: messages.at(-1)?.id ?? null,
      included: built.included,
    };
  }

  async getLevelScale(
    commandId: string,
    conversationId: string
  ): Promise<AiLevelScale> {
    const command = this.#findCommand(commandId);
    if (!command || !command.levels) {
      throw new Error(`command ${commandId} has no levels`);
    }
    const { levels } = command;
    const cacheKey = `${conversationId}|${commandId}`;
    const ttl = this.#loaded.config.context.scaleTtlMs;

    if (!levels.evolving) {
      return {
        commandId,
        conversationId,
        levels: fallbackScale(levels.count, levels.describe),
        generatedAt: Date.now(),
        source: 'fallback',
        messageCount: 0,
      };
    }

    const inFlight = this.#scaleInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const work = (async (): Promise<AiLevelScale> => {
      const ctx = await this.#transcriptFor(command, conversationId);
      const cached = this.#scaleCache.get(cacheKey);
      if (
        cached &&
        cached.lastMessageId === ctx.lastMessageId &&
        Date.now() - cached.scale.generatedAt < ttl
      ) {
        return cached.scale;
      }

      const prompt = buildScalePrompt({
        commandLabel: command.label,
        commandPrompt: command.prompt,
        describe: levels.describe,
        count: levels.count,
        conversationTitle: ctx.title,
        myName: ctx.myName,
        transcript: ctx.transcript,
      });
      let scale: AiLevelScale;
      try {
        const reply = await chatCompletion(this.#loaded.config.llm, prompt, {
          extraBody: this.#loaded.config.llm.scaleExtraBody,
        });
        const parsed = parseScale(
          cleanReply(reply.text),
          levels.count,
          levels.describe
        );
        scale = {
          commandId,
          conversationId,
          levels: parsed ?? fallbackScale(levels.count, levels.describe),
          generatedAt: Date.now(),
          source: parsed ? 'model' : 'fallback',
          messageCount: ctx.included,
        };
        log.info(
          `level scale for ${commandId}: source=${scale.source} promptChars=${prompt.length} outChars=${reply.text.length} durationMs=${reply.durationMs} messages=${ctx.included}`
        );
      } catch (error) {
        log.warn(
          `level scale for ${commandId} fell back: ${error instanceof Error ? error.message : String(error)}`
        );
        scale = {
          commandId,
          conversationId,
          levels: fallbackScale(levels.count, levels.describe),
          generatedAt: Date.now(),
          source: 'fallback',
          messageCount: ctx.included,
        };
      }
      if (this.#scaleCache.size >= SCALE_CACHE_MAX) {
        const oldest = this.#scaleCache.keys().next().value;
        if (oldest != null) {
          this.#scaleCache.delete(oldest);
        }
      }
      this.#scaleCache.set(cacheKey, {
        scale,
        lastMessageId: ctx.lastMessageId,
      });
      return scale;
    })();

    this.#scaleInFlight.set(cacheKey, work);
    try {
      return await work;
    } finally {
      this.#scaleInFlight.delete(cacheKey);
    }
  }

  async runCommand(
    commandId: string,
    conversationId: string,
    level: number | null
  ): Promise<AiRunResult> {
    const command = this.#findCommand(commandId);
    if (!command) {
      return { ok: false, error: `Unknown command "${commandId}"` };
    }
    if (!this.#loaded.config.enabled) {
      return { ok: false, error: 'AI commands are disabled in the config' };
    }
    try {
      const ctx = await this.#transcriptFor(command, conversationId);
      let levelDescriptor = null;
      if (command.levels) {
        const chosen = level ?? command.levels.default;
        const scale = await this.getLevelScale(commandId, conversationId);
        levelDescriptor =
          scale.levels.find(entry => entry.level === chosen) ??
          fallbackScale(command.levels.count, command.levels.describe)[
            chosen - 1
          ] ??
          null;
      }
      const prompt = buildCommandPrompt({
        commandLabel: command.label,
        commandPrompt: command.prompt,
        conversationTitle: ctx.title,
        isGroup: ctx.isGroup,
        myName: ctx.myName,
        transcript: ctx.transcript,
        maxChars: command.maxChars,
        level: levelDescriptor,
        levelCount: command.levels?.count ?? null,
        levelDescribe: command.levels?.describe ?? null,
        extraInstructions: command.extraInstructions,
      });
      const reply = await chatCompletion(this.#loaded.config.llm, prompt);
      const prefix = command.prefix ?? this.#loaded.config.resultPrefix;
      const generated = cleanReply(reply.text);
      const text = generated ? `${prefix}${generated}` : '';
      log.info(
        `run ${commandId} level=${level ?? '-'} promptChars=${prompt.length} outChars=${text.length} durationMs=${reply.durationMs} messages=${ctx.included}`
      );
      if (!text) {
        return { ok: false, error: 'The model returned an empty reply' };
      }
      return { ok: true, text, durationMs: reply.durationMs };
    } catch (error) {
      const message =
        error instanceof LlmError
          ? error.message
          : `Command failed: ${error instanceof Error ? error.message : String(error)}`;
      log.warn(`run ${commandId} failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  #registerIpc(): void {
    ipcMain.handle(AI_IPC.getClientConfig, () => this.clientConfig);
    ipcMain.handle(
      AI_IPC.getLevelScale,
      (_event, commandId: unknown, conversationId: unknown) => {
        if (
          typeof commandId !== 'string' ||
          typeof conversationId !== 'string'
        ) {
          throw new Error('invalid arguments');
        }
        return this.getLevelScale(commandId, conversationId);
      }
    );
    ipcMain.handle(
      AI_IPC.run,
      (_event, commandId: unknown, conversationId: unknown, level: unknown) => {
        if (
          typeof commandId !== 'string' ||
          typeof conversationId !== 'string'
        ) {
          throw new Error('invalid arguments');
        }
        const parsedLevel =
          typeof level === 'number' && Number.isInteger(level) && level >= 1
            ? level
            : null;
        return this.runCommand(commandId, conversationId, parsedLevel);
      }
    );
    ipcMain.handle(AI_IPC.openConfig, async () => {
      const result = await shell.openPath(this.#configPath);
      if (result) {
        log.warn(`openPath failed: ${result}`);
        shell.showItemInFolder(this.#configPath);
      }
    });
    ipcMain.on(
      AI_IPC.setActiveConversation,
      (_event, conversationId: unknown) => {
        this.setActiveConversation(
          typeof conversationId === 'string' && conversationId
            ? conversationId
            : null
        );
      }
    );
  }
}

let service: AiCommandsService | undefined;

export async function initializeAiCommands(
  options: AiCommandsServiceOptions
): Promise<AiCommandsService> {
  if (service) {
    return service;
  }
  service = new AiCommandsService(options);
  await service.start();
  return service;
}
