// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useMemo, useState, type JSX } from 'react';
import classNames from 'classnames';

import { AxoDropdownMenu } from '../../axo/AxoDropdownMenu.dom.tsx';
import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';
import type { AxoSymbol } from '../../axo/AxoSymbol.dom.tsx';
import { _getAllAxoSymbolNames } from '../../axo/_internal/AxoSymbolDefs.generated.std.ts';
import type { LocalizerType } from '../../types/Util.std.ts';
import type {
  AiCommandSummary,
  AiLevelDescriptor,
  AiLevelScale,
  AiRunResult,
} from '../../ai/types.std.ts';

export type AiCommandsProps = Readonly<{
  i18n: LocalizerType;
  conversationId: string;
  commands: ReadonlyArray<AiCommandSummary>;
  providerLabel: string | null;
  getLevelScale: (
    commandId: string,
    conversationId: string
  ) => Promise<AiLevelScale>;
  runCommand: (
    commandId: string,
    conversationId: string,
    level: number | null
  ) => Promise<AiRunResult>;
  openConfig: () => void;
  onResult: (text: string, options: { autoSend: boolean }) => void;
  onError: (message: string) => void;
}>;

const MENU_SYMBOL: AxoSymbol.Name = 'lightbulb';
const DEFAULT_COMMAND_SYMBOL: AxoSymbol.Name = 'bolt';

let symbolNames: ReadonlySet<string> | undefined;

function resolveSymbol(
  name: string | null,
  fallback: AxoSymbol.Name
): AxoSymbol.Name {
  if (!name) {
    return fallback;
  }
  symbolNames ??= new Set<string>(_getAllAxoSymbolNames());
  return symbolNames.has(name) ? (name as AxoSymbol.Name) : fallback;
}

type ScaleState =
  | { status: 'loading' }
  | { status: 'ready'; scale: AiLevelScale };

function placeholderLevels(
  i18n: LocalizerType,
  count: number
): ReadonlyArray<AiLevelDescriptor> {
  return Array.from({ length: count }, (_, index) => ({
    level: index + 1,
    title: i18n('icu:AiCommands__level-placeholder', {
      level: String(index + 1),
    }),
    description: i18n('icu:AiCommands__level-loading'),
  }));
}

type LevelItemsProps = Readonly<{
  i18n: LocalizerType;
  command: AiCommandSummary;
  scaleState: ScaleState | undefined;
  disabled: boolean;
  onPick: (level: number) => void;
}>;

const LevelItems = memo(function LevelItems({
  i18n,
  command,
  scaleState,
  disabled,
  onPick,
}: LevelItemsProps): JSX.Element | null {
  const { levels } = command;
  if (!levels) {
    return null;
  }
  const ready = scaleState?.status === 'ready' ? scaleState.scale : null;
  const entries = ready?.levels ?? placeholderLevels(i18n, levels.count);
  let footer: string;
  if (!ready) {
    footer = i18n('icu:AiCommands__level-loading');
  } else if (ready.source === 'model') {
    footer = i18n('icu:AiCommands__scale-model');
  } else {
    footer = i18n('icu:AiCommands__scale-generic');
  }
  return (
    <>
      <AxoDropdownMenu.Label>
        {command.label}
        {levels.describe ? ` · ${levels.describe}` : ''}
      </AxoDropdownMenu.Label>
      {entries.map(entry => (
        <AxoDropdownMenu.Item
          key={entry.level}
          disabled={disabled}
          onSelect={() => onPick(entry.level)}
        >
          <span
            className={classNames('AiCommands__level', {
              'AiCommands__level--default': entry.level === levels.default,
            })}
          >
            <span className="AiCommands__level-number">{entry.level}</span>
            <span className="AiCommands__level-text">
              <span className="AiCommands__level-title">{entry.title}</span>
              {entry.description ? (
                <span className="AiCommands__level-desc">
                  {entry.description}
                </span>
              ) : null}
            </span>
          </span>
        </AxoDropdownMenu.Item>
      ))}
      <div className="AiCommands__footer">{footer}</div>
    </>
  );
});

export const AiCommands = memo(function AiCommands({
  i18n,
  conversationId,
  commands,
  providerLabel,
  getLevelScale,
  runCommand,
  openConfig,
  onResult,
  onError,
}: AiCommandsProps): JSX.Element | null {
  const [runningId, setRunningId] = useState<string | null>(null);
  // Scales are per conversation AND command, so switching chats never shows
  // another chat's scale.
  const [scales, setScales] = useState<Record<string, ScaleState>>({});
  const scaleKey = useCallback(
    (command: AiCommandSummary) => `${conversationId}|${command.id}`,
    [conversationId]
  );

  const ensureScale = useCallback(
    (command: AiCommandSummary) => {
      if (!command.levels) {
        return;
      }
      const key = scaleKey(command);
      let alreadyRequested = false;
      setScales(previous => {
        if (previous[key]) {
          alreadyRequested = true;
          return previous;
        }
        return { ...previous, [key]: { status: 'loading' } };
      });
      if (alreadyRequested) {
        return;
      }
      const load = async () => {
        try {
          const scale = await getLevelScale(command.id, conversationId);
          setScales(previous => ({
            ...previous,
            [key]: { status: 'ready', scale },
          }));
        } catch {
          // Picking a level still works: the main process falls back to a
          // generic scale when running the command.
          setScales(previous => {
            const next = { ...previous };
            delete next[key];
            return next;
          });
        }
      };
      void load();
    },
    [conversationId, getLevelScale, scaleKey]
  );

  const run = useCallback(
    (command: AiCommandSummary, level: number | null) => {
      if (runningId) {
        return;
      }
      setRunningId(command.id);
      const execute = async () => {
        try {
          const result = await runCommand(command.id, conversationId, level);
          if (result.ok) {
            onResult(result.text, { autoSend: command.autoSend });
          } else {
            onError(result.error);
          }
          setRunningId(null);
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
          setRunningId(null);
        }
      };
      void execute();
    },
    [conversationId, onError, onResult, runCommand, runningId]
  );

  const pinned = useMemo(
    () => commands.filter(command => command.pinned),
    [commands]
  );

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        return;
      }
      for (const command of commands) {
        if (command.levels?.evolving) {
          ensureScale(command);
        }
      }
    },
    [commands, ensureScale]
  );

  if (commands.length === 0) {
    return null;
  }

  const busy = runningId != null;
  const menuLabel = i18n('icu:AiCommands__menu-label');

  return (
    <div className="AiCommands">
      {pinned.map(command => {
        const symbol = resolveSymbol(command.symbol, DEFAULT_COMMAND_SYMBOL);
        const isRunning = runningId === command.id;
        if (!command.levels) {
          return (
            <AxoIconButton.Root
              key={command.id}
              symbol={symbol}
              variant="implied-secondary"
              size="md"
              label={
                isRunning ? i18n('icu:AiCommands__pending') : command.label
              }
              pending={isRunning}
              disabled={busy && !isRunning}
              onClick={() => run(command, null)}
            />
          );
        }
        return (
          <AxoDropdownMenu.Root
            key={command.id}
            onOpenChange={open => {
              if (open) {
                ensureScale(command);
              }
            }}
          >
            <AxoDropdownMenu.Trigger disabled={busy && !isRunning}>
              <AxoIconButton.Root
                symbol={symbol}
                variant="implied-secondary"
                size="md"
                label={
                  isRunning ? i18n('icu:AiCommands__pending') : command.label
                }
                pending={isRunning}
                disabled={busy && !isRunning}
              />
            </AxoDropdownMenu.Trigger>
            <AxoDropdownMenu.Content side="top" align="end">
              <LevelItems
                i18n={i18n}
                command={command}
                scaleState={scales[scaleKey(command)]}
                disabled={busy}
                onPick={level => run(command, level)}
              />
            </AxoDropdownMenu.Content>
          </AxoDropdownMenu.Root>
        );
      })}
      <AxoDropdownMenu.Root onOpenChange={handleMenuOpenChange}>
        <AxoDropdownMenu.Trigger>
          <AxoIconButton.Root
            symbol={MENU_SYMBOL}
            variant="implied-secondary"
            size="md"
            label={busy ? i18n('icu:AiCommands__pending') : menuLabel}
            pending={busy && !pinned.some(command => command.id === runningId)}
          />
        </AxoDropdownMenu.Trigger>
        <AxoDropdownMenu.Content side="top" align="end">
          <AxoDropdownMenu.Label>
            {providerLabel ? `${menuLabel} · ${providerLabel}` : menuLabel}
          </AxoDropdownMenu.Label>
          {commands.map(command => {
            const symbol = resolveSymbol(
              command.symbol,
              DEFAULT_COMMAND_SYMBOL
            );
            if (!command.levels) {
              return (
                <AxoDropdownMenu.Item
                  key={command.id}
                  symbol={symbol}
                  disabled={busy}
                  onSelect={() => run(command, null)}
                >
                  {command.label}
                </AxoDropdownMenu.Item>
              );
            }
            return (
              <AxoDropdownMenu.Sub key={command.id}>
                <AxoDropdownMenu.SubTrigger disabled={busy}>
                  {command.label}
                </AxoDropdownMenu.SubTrigger>
                <AxoDropdownMenu.SubContent>
                  <LevelItems
                    i18n={i18n}
                    command={command}
                    scaleState={scales[scaleKey(command)]}
                    disabled={busy}
                    onPick={level => run(command, level)}
                  />
                </AxoDropdownMenu.SubContent>
              </AxoDropdownMenu.Sub>
            );
          })}
          <AxoDropdownMenu.Separator />
          <AxoDropdownMenu.Item symbol="settings" onSelect={openConfig}>
            {i18n('icu:AiCommands__edit')}
          </AxoDropdownMenu.Item>
        </AxoDropdownMenu.Content>
      </AxoDropdownMenu.Root>
    </div>
  );
});
