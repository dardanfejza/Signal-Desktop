// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcRenderer } from 'electron';
import { useEffect, useState } from 'react';

import {
  AI_IPC,
  type AiCommandsClientConfig,
  type AiComposeRequest,
  type AiLevelScale,
  type AiRunResult,
} from './types.std.ts';

function getAiClientConfig(): Promise<AiCommandsClientConfig> {
  return ipcRenderer.invoke(AI_IPC.getClientConfig);
}

export function getAiLevelScale(
  commandId: string,
  conversationId: string
): Promise<AiLevelScale> {
  return ipcRenderer.invoke(AI_IPC.getLevelScale, commandId, conversationId);
}

export function runAiCommand(
  commandId: string,
  conversationId: string,
  level: number | null
): Promise<AiRunResult> {
  return ipcRenderer.invoke(AI_IPC.run, commandId, conversationId, level);
}

export function openAiConfig(): Promise<void> {
  return ipcRenderer.invoke(AI_IPC.openConfig);
}

export function setAiActiveConversation(conversationId: string | null): void {
  ipcRenderer.send(AI_IPC.setActiveConversation, conversationId);
}

export function subscribeAiCompose(
  callback: (request: AiComposeRequest) => void
): () => void {
  const listener = (_event: unknown, request: AiComposeRequest) => {
    if (
      request &&
      typeof request.conversationId === 'string' &&
      typeof request.text === 'string'
    ) {
      callback(request);
    }
  };
  ipcRenderer.on(AI_IPC.compose, listener);
  return () => {
    ipcRenderer.removeListener(AI_IPC.compose, listener);
  };
}

/** Loads the client config once and follows live edits of the config file. */
export function useAiCommandsConfig(): AiCommandsClientConfig | null {
  const [config, setConfig] = useState<AiCommandsClientConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let loaded: AiCommandsClientConfig | null = null;
      try {
        loaded = await getAiClientConfig();
      } catch {
        loaded = null;
      }
      if (!cancelled) {
        setConfig(loaded);
      }
    };
    void load();
    const listener = (_event: unknown, next: AiCommandsClientConfig) => {
      if (!cancelled) {
        setConfig(next);
      }
    };
    ipcRenderer.on(AI_IPC.configChanged, listener);
    return () => {
      cancelled = true;
      ipcRenderer.removeListener(AI_IPC.configChanged, listener);
    };
  }, []);
  return config;
}
