// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useMemo, useState, type JSX } from 'react';

import { AxoDropdownMenu } from '../../axo/AxoDropdownMenu.dom.tsx';
import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';
import type { AxoSymbol } from '../../axo/AxoSymbol.dom.tsx';
import { _getAllAxoSymbolNames } from '../../axo/_internal/AxoSymbolDefs.generated.std.ts';
import type { LocalizerType } from '../../types/Util.std.ts';
import type {
  AiCommandSummary,
  AiLevelScale,
  AiRunResult,
} from '../../ai/types.std.ts';
import { AiLevelPicker } from './AiLevelPicker.dom.tsx';

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
  // Which leveled command's picker is open (at most one at a time).
  const [pickerId, setPickerId] = useState<string | null>(null);
  // Scales are keyed per conversation AND command, so switching chats never
  // shows another chat's scale. `null` = request in flight.
  const [scales, setScales] = useState<Record<string, AiLevelScale | null>>({});
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
        if (key in previous) {
          alreadyRequested = true;
          return previous;
        }
        return { ...previous, [key]: null };
      });
      if (alreadyRequested) {
        return;
      }
      const load = async () => {
        try {
          const scale = await getLevelScale(command.id, conversationId);
          setScales(previous => ({ ...previous, [key]: scale }));
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

  const openPicker = useCallback(
    (command: AiCommandSummary) => {
      ensureScale(command);
      setPickerId(command.id);
    },
    [ensureScale]
  );

  const activate = useCallback(
    (command: AiCommandSummary) => {
      if (command.levels) {
        openPicker(command);
      } else {
        run(command, null);
      }
    },
    [openPicker, run]
  );

  const pinned = useMemo(
    () => commands.filter(command => command.pinned),
    [commands]
  );
  const pickerCommand = useMemo(
    () => commands.find(command => command.id === pickerId) ?? null,
    [commands, pickerId]
  );

  if (commands.length === 0) {
    return null;
  }

  const busy = runningId != null;
  const menuLabel = i18n('icu:AiCommands__menu-label');
  const menuIsRunning =
    busy && !pinned.some(command => command.id === runningId);

  const buttons = (
    <div className="AiCommands">
      {pinned.map(command => {
        const isRunning = runningId === command.id;
        return (
          <AxoIconButton.Root
            key={command.id}
            symbol={resolveSymbol(command.symbol, DEFAULT_COMMAND_SYMBOL)}
            variant="implied-secondary"
            size="md"
            label={isRunning ? i18n('icu:AiCommands__pending') : command.label}
            pending={isRunning}
            pressed={pickerId === command.id}
            disabled={busy && !isRunning}
            onClick={() => activate(command)}
          />
        );
      })}
      <AxoDropdownMenu.Root>
        <AxoDropdownMenu.Trigger>
          <AxoIconButton.Root
            symbol={MENU_SYMBOL}
            variant="implied-secondary"
            size="md"
            label={menuIsRunning ? i18n('icu:AiCommands__pending') : menuLabel}
            pending={menuIsRunning}
          />
        </AxoDropdownMenu.Trigger>
        <AxoDropdownMenu.Content side="top" align="end">
          <AxoDropdownMenu.Label>
            {providerLabel ? `${menuLabel} · ${providerLabel}` : menuLabel}
          </AxoDropdownMenu.Label>
          {commands.map(command => (
            <AxoDropdownMenu.Item
              key={command.id}
              symbol={resolveSymbol(command.symbol, DEFAULT_COMMAND_SYMBOL)}
              disabled={busy}
              onSelect={() => activate(command)}
            >
              {command.label}
              {command.levels ? ` · 1–${command.levels.count}` : ''}
            </AxoDropdownMenu.Item>
          ))}
          <AxoDropdownMenu.Separator />
          <AxoDropdownMenu.Item symbol="settings" onSelect={openConfig}>
            {i18n('icu:AiCommands__edit')}
          </AxoDropdownMenu.Item>
        </AxoDropdownMenu.Content>
      </AxoDropdownMenu.Root>
    </div>
  );

  if (!pickerCommand?.levels) {
    return buttons;
  }

  return (
    <AiLevelPicker
      i18n={i18n}
      command={pickerCommand}
      scale={scales[scaleKey(pickerCommand)] ?? undefined}
      open={pickerId === pickerCommand.id}
      disabled={busy}
      onOpenChange={open => {
        if (!open) {
          setPickerId(null);
        }
      }}
      onPick={level => run(pickerCommand, level)}
    >
      {buttons}
    </AiLevelPicker>
  );
});
