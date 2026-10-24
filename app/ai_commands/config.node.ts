// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  watchFile,
  unwatchFile,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  AiCommandLevels,
  AiCommandSummary,
  AiCommandsClientConfig,
} from '../../ts/ai/types.std.ts';
import type { LlmSettings } from './llm.std.ts';

const CONFIG_FILE_NAME = 'ai-commands.json';

export type AiCommandDefinition = Readonly<{
  id: string;
  label: string;
  symbol: string | null;
  pinned: boolean;
  /** The instruction handed to the model, e.g. "mrhuang, insult sean". */
  prompt: string;
  levels: AiCommandLevels | null;
  autoSend: boolean;
  /** Character budget hint for the generated message. */
  maxChars: number;
  /** Overrides `context.messageCount` for this command when set. */
  contextMessages: number | null;
  extraInstructions: string | null;
}>;

export type LocalApiSettings = Readonly<{
  enabled: boolean;
  host: string;
  port: number;
  token: string;
}>;

export type AiCommandsConfig = Readonly<{
  enabled: boolean;
  localApi: LocalApiSettings;
  llm: LlmSettings &
    Readonly<{
      label: string;
      /** Merged into the level-scale request only (e.g. thinking off). */
      scaleExtraBody: Readonly<Record<string, unknown>> | null;
    }>;
  context: Readonly<{
    messageCount: number;
    maxChars: number;
    /** Level scales are regenerated after this many ms even if the chat is quiet. */
    scaleTtlMs: number;
  }>;
  commands: ReadonlyArray<AiCommandDefinition>;
}>;

export type LoadedConfig = Readonly<{
  config: AiCommandsConfig;
  path: string;
  created: boolean;
  warnings: ReadonlyArray<string>;
}>;

const DEFAULT_LLM = {
  label: 'MrHuang',
  baseUrl: 'http://100.117.221.48:3000/v1',
  apiKey: '',
  model: 'mrhuang',
  timeoutMs: 180_000,
  systemPrompt: '',
  maxOutputTokens: null,
  temperature: null,
  extraBody: null,
  scaleExtraBody: null,
} satisfies AiCommandsConfig['llm'];

function defaultCommands(): Array<AiCommandDefinition> {
  return [
    {
      id: 'insult-sean',
      label: 'Insult Sean',
      symbol: 'bolt-fill',
      pinned: true,
      prompt: 'mrhuang, insult sean',
      levels: {
        count: 10,
        default: 5,
        evolving: true,
        describe: 'how brutal the insult is',
      },
      autoSend: false,
      maxChars: 280,
      contextMessages: null,
      extraInstructions:
        'Target Sean only. Punch at what he actually said or did in the chat, never at protected traits.',
    },
    {
      id: 'hype-last',
      label: 'Hype the last message',
      symbol: 'star-fill',
      pinned: false,
      prompt:
        'Hype up whoever sent the most recent message, reacting to what they said.',
      levels: {
        count: 10,
        default: 6,
        evolving: true,
        describe: 'how over-the-top the hype is',
      },
      autoSend: false,
      maxChars: 240,
      contextMessages: null,
      extraInstructions: null,
    },
    {
      id: 'reply-for-me',
      label: 'Reply for me',
      symbol: 'compose',
      pinned: false,
      prompt:
        'Write the reply I would most plausibly send next, picking up the thread naturally.',
      levels: null,
      autoSend: false,
      maxChars: 400,
      contextMessages: null,
      extraInstructions: null,
    },
    {
      id: 'catch-me-up',
      label: 'Catch me up',
      symbol: 'list-bullet',
      pinned: false,
      prompt:
        'Summarize what happened in this chat recently in at most three short lines addressed to me. This is a note for me, not something I will send.',
      levels: null,
      autoSend: false,
      maxChars: 500,
      contextMessages: 80,
      extraInstructions: null,
    },
  ];
}

function defaultConfigDocument(token: string): Record<string, unknown> {
  return {
    _help: [
      'AI commands for the Signal Desktop fork. Edit and save; the app reloads it live.',
      'llm.baseUrl: any OpenAI-compatible /v1. MrHuang companion: http://<truenas>:3000/v1 with model "mrhuang" and apiKey = API_TOKEN.',
      'Raw vLLM instead: baseUrl http://<truenas>:8000/v1, model "Qwen3.8-27B", apiKey "". Speed up the 1..N scale call with llm.scaleExtraBody = {"chat_template_kwargs": {"enable_thinking": false}} (raw vLLM only; MrHuang ignores generation params).',
      'localApi: loopback HTTP API over this client\'s data. Auth: "Authorization: Bearer <token>" or ?token=. See docs/ai-commands.md.',
      'commands[].levels: set to null for a one-click command, or {count, default, evolving, describe} for a 1..N intensity picker.',
    ],
    enabled: true,
    localApi: { enabled: true, host: '127.0.0.1', port: 7474, token },
    llm: { ...DEFAULT_LLM },
    context: { messageCount: 40, maxChars: 12_000, scaleTtlMs: 15 * 60_000 },
    commands: defaultCommands(),
  };
}

function generateToken(): string {
  return randomBytes(24).toString('hex');
}

export function getConfigPath(userDataPath: string): string {
  return join(userDataPath, CONFIG_FILE_NAME);
}

type Warn = (message: string) => void;

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asInt(
  value: unknown,
  fallback: number,
  { min, max }: { min: number; max: number },
  warn: Warn,
  name: string
): number {
  if (value == null) {
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    warn(`${name}: not a number, using ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, Math.round(n)));
  if (clamped !== n) {
    warn(`${name}: ${n} clamped to ${clamped}`);
  }
  return clamped;
}

function asNullableObject(
  value: unknown,
  warn: Warn,
  name: string
): Readonly<Record<string, unknown>> | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    warn(`${name}: expected a JSON object, ignored`);
    return null;
  }
  return value as Record<string, unknown>;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLevels(
  value: unknown,
  warn: Warn,
  name: string
): AiCommandLevels | null {
  if (value == null || value === false) {
    return null;
  }
  if (typeof value === 'number') {
    const count = asInt(value, 10, { min: 2, max: 20 }, warn, `${name}.levels`);
    return {
      count,
      default: Math.ceil(count / 2),
      evolving: true,
      describe: 'intensity',
    };
  }
  if (typeof value !== 'object') {
    warn(`${name}.levels: expected object or null`);
    return null;
  }
  const record = value as Record<string, unknown>;
  const count = asInt(
    record.count,
    10,
    { min: 2, max: 20 },
    warn,
    `${name}.levels.count`
  );
  return {
    count,
    default: asInt(
      record.default,
      Math.ceil(count / 2),
      { min: 1, max: count },
      warn,
      `${name}.levels.default`
    ),
    evolving: asBool(record.evolving, true),
    describe: asString(record.describe, 'intensity'),
  };
}

function normalizeCommand(
  value: unknown,
  index: number,
  warn: Warn
): AiCommandDefinition | null {
  if (!value || typeof value !== 'object') {
    warn(`commands[${index}]: not an object, skipped`);
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = `commands[${index}]`;
  const id = asString(record.id, '').trim();
  const prompt = asString(record.prompt, '').trim();
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    warn(
      `${name}: missing or invalid "id" (letters, digits, - and _), skipped`
    );
    return null;
  }
  if (!prompt) {
    warn(`${name} (${id}): missing "prompt", skipped`);
    return null;
  }
  const symbolRaw = asString(record.symbol, '').trim();
  return {
    id,
    label: asString(record.label, id).trim() || id,
    symbol: symbolRaw || null,
    pinned: asBool(record.pinned, false),
    prompt,
    levels: normalizeLevels(record.levels, warn, `${name} (${id})`),
    autoSend: asBool(record.autoSend, false),
    maxChars: asInt(
      record.maxChars,
      300,
      { min: 20, max: 4000 },
      warn,
      `${name}.maxChars`
    ),
    contextMessages:
      record.contextMessages == null
        ? null
        : asInt(
            record.contextMessages,
            40,
            { min: 1, max: 500 },
            warn,
            `${name}.contextMessages`
          ),
    extraInstructions: asString(record.extraInstructions, '').trim() || null,
  };
}

export function normalizeConfig(
  raw: unknown,
  warn: Warn
): { config: AiCommandsConfig; tokenGenerated: boolean } {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const localApiRaw = (
    root.localApi && typeof root.localApi === 'object' ? root.localApi : {}
  ) as Record<string, unknown>;
  const llmRaw = (
    root.llm && typeof root.llm === 'object' ? root.llm : {}
  ) as Record<string, unknown>;
  const contextRaw = (
    root.context && typeof root.context === 'object' ? root.context : {}
  ) as Record<string, unknown>;

  let tokenGenerated = false;
  let token = asString(localApiRaw.token, '').trim();
  if (token.length < 16) {
    if (token) {
      warn('localApi.token: shorter than 16 characters, regenerated');
    }
    token = generateToken();
    tokenGenerated = true;
  }

  const commandsRaw = Array.isArray(root.commands) ? root.commands : [];
  const seen = new Set<string>();
  const commands: Array<AiCommandDefinition> = [];
  commandsRaw.forEach((entry, index) => {
    const command = normalizeCommand(entry, index, warn);
    if (!command) {
      return;
    }
    if (seen.has(command.id)) {
      warn(`commands[${index}]: duplicate id "${command.id}", skipped`);
      return;
    }
    seen.add(command.id);
    commands.push(command);
  });

  const config: AiCommandsConfig = {
    enabled: asBool(root.enabled, true),
    localApi: {
      enabled: asBool(localApiRaw.enabled, true),
      host: asString(localApiRaw.host, '127.0.0.1').trim() || '127.0.0.1',
      port: asInt(
        localApiRaw.port,
        7474,
        { min: 1, max: 65535 },
        warn,
        'localApi.port'
      ),
      token,
    },
    llm: {
      label: asString(llmRaw.label, DEFAULT_LLM.label),
      baseUrl: asString(llmRaw.baseUrl, DEFAULT_LLM.baseUrl).trim(),
      apiKey: asString(llmRaw.apiKey, ''),
      model: asString(llmRaw.model, DEFAULT_LLM.model).trim(),
      timeoutMs: asInt(
        llmRaw.timeoutMs,
        DEFAULT_LLM.timeoutMs,
        { min: 5_000, max: 1_800_000 },
        warn,
        'llm.timeoutMs'
      ),
      systemPrompt: asString(llmRaw.systemPrompt, ''),
      maxOutputTokens: asNullableNumber(llmRaw.maxOutputTokens),
      temperature: asNullableNumber(llmRaw.temperature),
      extraBody: asNullableObject(llmRaw.extraBody, warn, 'llm.extraBody'),
      scaleExtraBody: asNullableObject(
        llmRaw.scaleExtraBody,
        warn,
        'llm.scaleExtraBody'
      ),
    },
    context: {
      messageCount: asInt(
        contextRaw.messageCount,
        40,
        { min: 1, max: 500 },
        warn,
        'context.messageCount'
      ),
      maxChars: asInt(
        contextRaw.maxChars,
        12_000,
        { min: 500, max: 200_000 },
        warn,
        'context.maxChars'
      ),
      scaleTtlMs: asInt(
        contextRaw.scaleTtlMs,
        15 * 60_000,
        { min: 10_000, max: 24 * 3_600_000 },
        warn,
        'context.scaleTtlMs'
      ),
    },
    commands,
  };
  if (!/^https?:\/\//i.test(config.llm.baseUrl)) {
    warn(`llm.baseUrl: "${config.llm.baseUrl}" is not an http(s) URL`);
  }
  if (
    config.localApi.host !== '127.0.0.1' &&
    config.localApi.host !== 'localhost' &&
    config.localApi.host !== '::1'
  ) {
    warn(
      `localApi.host: "${config.localApi.host}" is not loopback — every message in this client is readable with the token`
    );
  }
  return { config, tokenGenerated };
}

/**
 * Loads (and if necessary creates) the config file. Never throws on a bad
 * file: it falls back to defaults and reports warnings so the app still boots.
 */
export function loadConfig(path: string): LoadedConfig {
  const warnings: Array<string> = [];
  const warn: Warn = message => warnings.push(message);

  let raw: unknown;
  let created = false;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      raw = defaultConfigDocument(generateToken());
      created = true;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, {
          mode: 0o600,
        });
      } catch (writeError) {
        warn(
          `could not write default config: ${writeError instanceof Error ? writeError.message : String(writeError)}`
        );
      }
    } else {
      warn(
        `config unreadable (${error instanceof Error ? error.message : String(error)}); using defaults`
      );
      raw = defaultConfigDocument(generateToken());
    }
  }

  const { config, tokenGenerated } = normalizeConfig(raw, warn);
  if (tokenGenerated && !created && raw && typeof raw === 'object') {
    // Persist the generated token so external tools can read it from the file.
    try {
      const doc = raw as Record<string, unknown>;
      const localApi = (
        doc.localApi && typeof doc.localApi === 'object' ? doc.localApi : {}
      ) as Record<string, unknown>;
      doc.localApi = { ...localApi, token: config.localApi.token };
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    } catch (writeError) {
      warn(
        `could not persist generated token: ${writeError instanceof Error ? writeError.message : String(writeError)}`
      );
    }
  }
  return { config, path, created, warnings };
}

export function toCommandSummary(
  command: AiCommandDefinition
): AiCommandSummary {
  return {
    id: command.id,
    label: command.label,
    symbol: command.symbol,
    pinned: command.pinned,
    levels: command.levels,
    autoSend: command.autoSend,
  };
}

export function toClientConfig(loaded: LoadedConfig): AiCommandsClientConfig {
  return {
    enabled: loaded.config.enabled,
    providerLabel: loaded.config.llm.label,
    configPath: loaded.path,
    commands: loaded.config.commands.map(toCommandSummary),
  };
}

/** Polls the file (works on every filesystem) and debounces edits. */
export function watchConfig(path: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const listener = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(onChange, 300);
  };
  watchFile(path, { interval: 2000 }, listener);
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    unwatchFile(path, listener);
  };
}
