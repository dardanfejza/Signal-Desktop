// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { AiLevelDescriptor } from '../../ts/ai/types.std.ts';

export type TranscriptMessage = Readonly<{
  timestamp: number;
  senderName: string;
  direction: 'incoming' | 'outgoing';
  body: string;
  attachments: ReadonlyArray<Readonly<{ contentType: string }>>;
  quoteText: string | null;
  reactions: ReadonlyArray<string>;
}>;

export type TranscriptOptions = Readonly<{
  /** Hard cap on transcript characters; oldest messages are dropped first. */
  maxChars: number;
  locale?: string;
}>;

function describeAttachment(contentType: string): string {
  if (contentType.startsWith('image/')) {
    return '[photo]';
  }
  if (contentType.startsWith('video/')) {
    return '[video]';
  }
  if (contentType.startsWith('audio/')) {
    return '[voice note]';
  }
  return '[file]';
}

function formatTime(timestamp: number, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function formatTranscriptLine(
  message: TranscriptMessage,
  locale?: string
): string {
  const parts: Array<string> = [];
  if (message.quoteText) {
    parts.push(`(replying to "${truncate(message.quoteText, 80)}")`);
  }
  const attachmentNotes = message.attachments.map(a =>
    describeAttachment(a.contentType)
  );
  const body = message.body.trim();
  if (body) {
    parts.push(body);
  }
  if (attachmentNotes.length > 0) {
    parts.push(attachmentNotes.join(' '));
  }
  if (message.reactions.length > 0) {
    parts.push(`{reactions: ${message.reactions.join(' ')}}`);
  }
  const text = parts.join(' ') || '[empty]';
  return `[${formatTime(message.timestamp, locale)}] ${message.senderName}: ${text}`;
}

/**
 * Renders messages (oldest first) into a plain-text transcript, dropping the
 * oldest lines until it fits within `maxChars`.
 */
export function buildTranscript(
  messages: ReadonlyArray<TranscriptMessage>,
  { maxChars, locale }: TranscriptOptions
): { text: string; included: number; dropped: number } {
  const lines = messages.map(m => formatTranscriptLine(m, locale));
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  let start = 0;
  while (start < lines.length - 1 && total > maxChars) {
    total -= (lines[start]?.length ?? 0) + 1;
    start += 1;
  }
  const kept = lines.slice(start);
  return {
    text: kept.join('\n'),
    included: kept.length,
    dropped: start,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export type CommandPromptInput = Readonly<{
  commandLabel: string;
  commandPrompt: string;
  conversationTitle: string;
  isGroup: boolean;
  myName: string;
  transcript: string;
  maxChars: number;
  level: AiLevelDescriptor | null;
  levelCount: number | null;
  levelDescribe: string | null;
  extraInstructions: string | null;
}>;

/**
 * Everything goes into ONE user message: MrHuang's `/v1` shim only reads the
 * last `user` message, and raw vLLM is happy either way.
 */
export function buildCommandPrompt(input: CommandPromptInput): string {
  const where = input.isGroup
    ? `the Signal group chat "${input.conversationTitle}"`
    : `a Signal chat with ${input.conversationTitle}`;
  const lines: Array<string> = [
    `You are ghost-writing a single chat message for ${input.myName}, who is about to send it in ${where}.`,
    '',
    `COMMAND: ${input.commandPrompt}`,
  ];
  if (input.level && input.levelCount) {
    lines.push(
      `INTENSITY: level ${input.level.level} of ${input.levelCount}` +
        (input.levelDescribe ? ` (${input.levelDescribe})` : '') +
        ` — "${input.level.title}": ${input.level.description}`
    );
  }
  lines.push(
    '',
    'RULES:',
    `- Reply with ONLY the message text, exactly as ${input.myName} would type it. No preamble, no quotes, no explanations, no markdown, no sign-off.`,
    `- Keep it under ${input.maxChars} characters. One message, not a list.`,
    '- Write in the language the chat is using. Match its tone and in-jokes; reference recent messages when it lands.',
    '- Stay at the requested intensity: do not go softer or harder than the level describes.',
    "- Never invent facts about real people that the conversation doesn't support."
  );
  if (input.extraInstructions) {
    lines.push(`- ${input.extraInstructions}`);
  }
  lines.push(
    '',
    `RECENT CONVERSATION (oldest first; "${input.myName}" is the sender you write for):`,
    '---',
    input.transcript || '(no recent messages)',
    '---',
    '',
    'Now write the message.'
  );
  return lines.join('\n');
}

export type ScalePromptInput = Readonly<{
  commandLabel: string;
  commandPrompt: string;
  describe: string;
  count: number;
  conversationTitle: string;
  myName: string;
  transcript: string;
}>;

export function buildScalePrompt(input: ScalePromptInput): string {
  return [
    `A Signal chat composer offers the button "${input.commandLabel}" (command: ${input.commandPrompt}) with an intensity dial from 1 to ${input.count}, where the dial controls ${input.describe}.`,
    `Using the recent conversation in "${input.conversationTitle}" below, describe what each level would produce RIGHT NOW, grounded in what people actually said (names, running jokes, recent events).`,
    '',
    'Return ONLY a JSON array (no prose, no markdown fences) with exactly ' +
      `${input.count} objects, ordered by level:`,
    '[{"level": 1, "title": "<2-3 word name>", "description": "<one sentence, max 90 characters, concrete to this chat>"}, ...]',
    '',
    `Level 1 is the gentlest, level ${input.count} the most extreme the command allows. Titles must be distinct and escalate.`,
    '',
    `RECENT CONVERSATION (oldest first; "${input.myName}" is the user):`,
    '---',
    input.transcript || '(no recent messages)',
    '---',
  ].join('\n');
}

export function fallbackScale(
  count: number,
  describe: string
): Array<AiLevelDescriptor> {
  const names = [
    'Featherlight',
    'Gentle',
    'Playful',
    'Cheeky',
    'Pointed',
    'Spicy',
    'Ruthless',
    'Savage',
    'Scorched earth',
    'Nuclear',
  ];
  return Array.from({ length: count }, (_, i) => {
    const level = i + 1;
    const title =
      (count === names.length ? names[i] : undefined) ?? `Level ${level}`;
    return {
      level,
      title,
      description: `${describe}: ${Math.round((level / count) * 100)}% of the way to the maximum.`,
    };
  });
}

/**
 * Pulls a JSON array out of a model reply that may be wrapped in fences or
 * prose, and normalizes it into exactly `count` descriptors.
 */
export function parseScale(
  raw: string,
  count: number,
  describe: string
): Array<AiLevelDescriptor> | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const byLevel = new Map<number, AiLevelDescriptor>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const level = Number(record.level);
    if (!Number.isInteger(level) || level < 1 || level > count) {
      continue;
    }
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const description =
      typeof record.description === 'string' ? record.description.trim() : '';
    if (!title && !description) {
      continue;
    }
    byLevel.set(level, {
      level,
      title: truncate(title || `Level ${level}`, 32),
      description: truncate(description, 140),
    });
  }
  if (byLevel.size < Math.ceil(count / 2)) {
    return null;
  }
  const fallback = fallbackScale(count, describe);
  return fallback.map(entry => byLevel.get(entry.level) ?? entry);
}

/** Strips reasoning blocks and surrounding quotes/fences from a reply. */
export function cleanReply(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence?.[1] != null) {
    text = fence[1].trim();
  }
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith('“') && text.endsWith('”')))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}
