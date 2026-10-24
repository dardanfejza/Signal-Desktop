// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { action } from '@storybook/addon-actions';

import type { AiCommandsProps } from './AiCommands.dom.tsx';
import { AiCommands } from './AiCommands.dom.tsx';
import { type ComponentMeta } from '../../storybook/types.std.ts';
import type {
  AiCommandSummary,
  AiLevelScale,
  AiRunResult,
} from '../../ai/types.std.ts';

const { i18n } = window.SignalContext;

const commands: ReadonlyArray<AiCommandSummary> = [
  {
    id: 'insult-sean',
    label: 'Insult Sean',
    symbol: 'bolt-fill',
    pinned: true,
    levels: {
      count: 10,
      default: 5,
      evolving: true,
      describe: 'how brutal the insult is',
    },
    autoSend: false,
  },
  {
    id: 'hype-last',
    label: 'Hype the last message',
    symbol: 'star-fill',
    pinned: false,
    levels: {
      count: 10,
      default: 6,
      evolving: true,
      describe: 'how over-the-top the hype is',
    },
    autoSend: false,
  },
  {
    id: 'reply-for-me',
    label: 'Reply for me',
    symbol: 'compose',
    pinned: false,
    levels: null,
    autoSend: false,
  },
];

const TITLES = [
  'Tiny Poke',
  'Mouse Joke',
  'Late Again',
  'Fed Count',
  'Lag Denial',
  'Nuro Blame',
  'Old Mouse',
  'Misclick Myth',
  'Feed Baron',
  'Nuro Meltdown',
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function getLevelScale(
  commandId: string,
  conversationId: string
): Promise<AiLevelScale> {
  await sleep(800);
  return {
    commandId,
    conversationId,
    generatedAt: Date.now(),
    source: 'model',
    levels: TITLES.map((title, index) => ({
      level: index + 1,
      title,
      description: `Level ${index + 1}: grounded in what Sean said about the new mouse.`,
    })),
  };
}

async function runCommand(
  commandId: string,
  _conversationId: string,
  level: number | null
): Promise<AiRunResult> {
  await sleep(1200);
  return {
    ok: true,
    text: `[${commandId} @ level ${level ?? '-'}] the old mouse caused 12 feeds because sean just hides in it.`,
    durationMs: 1200,
  };
}

async function failingRunCommand(): Promise<AiRunResult> {
  await sleep(600);
  return { ok: false, error: 'LLM returned HTTP 401: invalid token' };
}

export default {
  title: 'Components/Conversation/AiCommands',
  component: AiCommands,
  args: {
    i18n,
    conversationId: 'conv-1',
    commands,
    providerLabel: 'MrHuang',
    getLevelScale,
    runCommand,
    openConfig: action('openConfig'),
    onResult: action('onResult'),
    onError: action('onError'),
  },
} satisfies ComponentMeta<AiCommandsProps>;

export function Default(args: AiCommandsProps): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 16 }}>
      <AiCommands {...args} />
    </div>
  );
}

export function Failing(args: AiCommandsProps): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 16 }}>
      <AiCommands {...args} runCommand={failingRunCommand} />
    </div>
  );
}

export function NoPinned(args: AiCommandsProps): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 16 }}>
      <AiCommands
        {...args}
        commands={commands.map(command => ({ ...command, pinned: false }))}
      />
    </div>
  );
}
