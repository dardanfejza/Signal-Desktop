// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Minimal OpenAI-compatible chat client. Works against MrHuang's `/v1` shim
// (which only reads the last user message) and against raw vLLM.

export type LlmSettings = Readonly<{
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Sent as a `system` message when non-empty (ignored by MrHuang's shim). */
  systemPrompt: string;
  maxOutputTokens: number | null;
  temperature: number | null;
  /**
   * Extra JSON merged into every request body, e.g.
   * `{"chat_template_kwargs": {"enable_thinking": false}}` for raw vLLM.
   */
  extraBody: Readonly<Record<string, unknown>> | null;
}>;

export class LlmError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

export type ChatCompletionResult = Readonly<{
  text: string;
  durationMs: number;
  model: string | null;
}>;

export async function chatCompletion(
  settings: LlmSettings,
  userMessage: string,
  {
    extraBody,
    fetchImpl = fetch,
  }: Readonly<{
    /** Merged over `settings.extraBody` for this one call. */
    extraBody?: Readonly<Record<string, unknown>> | null;
    fetchImpl?: typeof fetch;
  }> = {}
): Promise<ChatCompletionResult> {
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const messages: Array<{ role: string; content: string }> = [];
  if (settings.systemPrompt) {
    messages.push({ role: 'system', content: settings.systemPrompt });
  }
  messages.push({ role: 'user', content: userMessage });

  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    stream: false,
  };
  if (settings.maxOutputTokens != null) {
    body.max_tokens = settings.maxOutputTokens;
  }
  if (settings.temperature != null) {
    body.temperature = settings.temperature;
  }
  Object.assign(body, settings.extraBody ?? {}, extraBody ?? {});

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (settings.apiKey) {
    headers.authorization = `Bearer ${settings.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new LlmError(
        `LLM request timed out after ${Math.round(settings.timeoutMs / 1000)}s`
      );
    }
    throw new LlmError(
      `LLM request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  clearTimeout(timer);

  const rawText = await response.text();
  if (!response.ok) {
    throw new LlmError(
      `LLM returned HTTP ${response.status}: ${rawText.slice(0, 200)}`,
      response.status
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new LlmError('LLM returned a non-JSON body');
  }
  const text = extractContent(json);
  if (text == null) {
    throw new LlmError('LLM reply had no message content');
  }
  const model =
    json &&
    typeof json === 'object' &&
    typeof (json as { model?: unknown }).model === 'string'
      ? (json as { model: string }).model
      : null;
  return { text, durationMs: Date.now() - startedAt, model };
}

function extractContent(json: unknown): string | null {
  if (!json || typeof json !== 'object') {
    return null;
  }
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  // Some servers return content parts.
  if (Array.isArray(content)) {
    const text = content
      .map(part =>
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('');
    return text || null;
  }
  return null;
}
