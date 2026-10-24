// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  memo,
  useCallback,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import classNames from 'classnames';
import { Popover } from 'radix-ui';

import { tw } from '../../axo/tw.dom.tsx';
import type { LocalizerType } from '../../types/Util.std.ts';
import type { AiCommandSummary, AiLevelScale } from '../../ai/types.std.ts';

export type AiLevelPickerProps = Readonly<{
  i18n: LocalizerType;
  command: AiCommandSummary;
  /** `undefined` while the scale is still being generated. */
  scale: AiLevelScale | undefined;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (level: number) => void;
  /** The element the popover is anchored to. */
  children: ReactNode;
}>;

const surfaceClassName = tw(
  'legacy-z-index-context-menu',
  'curved-xl bg-material-tertiary shadow-elevation-3 backdrop-blur-regular',
  'forced-colors:border'
);

/**
 * Compact intensity picker: one row of numbered chips, a single preview line
 * for the hovered/focused level, click (or Enter) to write at that level.
 */
export const AiLevelPicker = memo(function AiLevelPicker({
  i18n,
  command,
  scale,
  open,
  disabled,
  onOpenChange,
  onPick,
  children,
}: AiLevelPickerProps): JSX.Element {
  const levels = command.levels;
  const count = levels?.count ?? 0;
  const defaultLevel = levels?.default ?? 1;
  const [rawPreview, setPreview] = useState(defaultLevel);
  const preview = Math.min(Math.max(rawPreview, 1), Math.max(count, 1));

  // Re-arm the preview on the default each time the picker opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setPreview(defaultLevel);
    }
  }

  const pick = useCallback(
    (level: number) => {
      if (disabled) {
        return;
      }
      onPick(level);
      onOpenChange(false);
    },
    [disabled, onOpenChange, onPick]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        event.preventDefault();
        setPreview(level => Math.min(count, level + 1));
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        event.preventDefault();
        setPreview(level => Math.max(1, level - 1));
      } else if (event.key === 'Home') {
        event.preventDefault();
        setPreview(1);
      } else if (event.key === 'End') {
        event.preventDefault();
        setPreview(count);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        pick(preview);
      } else if (/^[0-9]$/.test(event.key)) {
        const typed = event.key === '0' ? 10 : Number(event.key);
        if (typed >= 1 && typed <= count) {
          event.preventDefault();
          setPreview(typed);
        }
      }
    },
    [count, pick, preview]
  );

  const descriptor = scale?.levels.find(entry => entry.level === preview);
  let caption: string;
  if (!scale) {
    caption = i18n('icu:AiCommands__level-loading');
  } else if (scale.source !== 'model') {
    caption = i18n('icu:AiCommands__scale-generic');
  } else if (scale.messageCount === 0) {
    caption = i18n('icu:AiCommands__scale-empty');
  } else {
    caption = i18n('icu:AiCommands__scale-from-messages', {
      count: scale.messageCount,
    });
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>{children}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className={classNames(surfaceClassName, 'AiLevelPicker')}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onKeyDown={handleKeyDown}
        >
          <div className="AiLevelPicker__header">
            <span className="AiLevelPicker__title">{command.label}</span>
            {levels?.describe ? (
              <span className="AiLevelPicker__describe">
                {' · '}
                {levels.describe}
              </span>
            ) : null}
          </div>
          <div
            className="AiLevelPicker__chips"
            role="radiogroup"
            aria-label={command.label}
          >
            {Array.from({ length: count }, (_, index) => {
              const level = index + 1;
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={level === preview}
                  tabIndex={level === preview ? 0 : -1}
                  disabled={disabled}
                  className={classNames('AiLevelPicker__chip', {
                    'AiLevelPicker__chip--preview': level === preview,
                    'AiLevelPicker__chip--default': level === defaultLevel,
                  })}
                  onMouseEnter={() => setPreview(level)}
                  onFocus={() => setPreview(level)}
                  onClick={() => pick(level)}
                >
                  {level}
                </button>
              );
            })}
          </div>
          <div className="AiLevelPicker__detail" aria-live="polite">
            <span className="AiLevelPicker__detail-title">
              {descriptor?.title ??
                i18n('icu:AiCommands__level-placeholder', {
                  level: String(preview),
                })}
            </span>
            {descriptor?.description ? (
              <span className="AiLevelPicker__detail-desc">
                {descriptor.description}
              </span>
            ) : null}
          </div>
          <div className="AiLevelPicker__caption">{caption}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
