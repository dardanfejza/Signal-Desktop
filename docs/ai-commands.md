# AI commands + local API (fork feature)

This fork adds two things to Signal Desktop, both off the beaten path of the
upstream code so rebasing stays cheap:

1. **AI command presets next to the microphone.** A lightbulb menu (and any
   command you pin as its own button) in the composer runs a preset against the
   recent messages of the _open_ chat and drops the result into the composer
   as a draft. Commands can carry a 1–N intensity picker whose per-level
   descriptions are written by the model from the current conversation.
2. **A loopback HTTP API** over what this client can see: conversations,
   recent messages, the currently open chat, and the presets themselves.

Everything lives in `app/ai_commands/` (main process), `ts/ai/` (shared types

- preload IPC) and `ts/components/conversation/AiCommands.dom.tsx` (UI). The
  only upstream files touched are `CompositionArea` (one optional prop group and
  one `{aiFragment}`), the toast enum, the stylesheet manifest, the locale file
  and a six-line hook in `app/main.main.ts`.

## Config

`<userData>/ai-commands.json` — created with defaults on first start and
reloaded live when saved (poll every 2 s). "Edit commands…" in the lightbulb
menu opens it. `userData` is `~/.config/Signal/` for a packaged build and
`~/.config/Signal-development/` for `pnpm start`.

```jsonc
{
  "enabled": true,
  "localApi": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 7474,
    "token": "<generated>",
  },
  "llm": {
    "label": "vLLM · Qwen3.8-27B",
    "baseUrl": "http://100.117.221.48:8000/v1", // raw vLLM engine, stateless
    "apiKey": "", // vLLM has no auth on the LAN
    "model": "Qwen3.8-27B", // the id vLLM advertises on /v1/models
    "timeoutMs": 180000,
    "systemPrompt": "",
    "maxOutputTokens": null,
    "temperature": null,
    "extraBody": null, // merged into every request body
    "scaleExtraBody": { "chat_template_kwargs": { "enable_thinking": false } }, // level-scale call only
  },
  "context": { "messageCount": 40, "maxChars": 12000, "scaleTtlMs": 900000 },
  "commands": [
    {
      "id": "insult-sean",
      "label": "Insult Sean",
      "symbol": "bolt-fill", // any Axo symbol name; falls back to "bolt"
      "pinned": true, // own button next to the mic
      "prompt": "mrhuang, insult sean",
      "levels": {
        "count": 10,
        "default": 5,
        "evolving": true,
        "describe": "how brutal the insult is",
      },
      "autoSend": false, // true = submit immediately instead of drafting
      "maxChars": 280,
      "contextMessages": null, // overrides context.messageCount
      "extraInstructions": "Target Sean only. Punch at what he actually said or did in the chat, never at protected traits.",
    },
  ],
}
```

- **Why raw vLLM and not MrHuang's `/v1`:** the companion shim writes every
  run into the owner's shared companion thread (and may extract memories from
  it). The raw engine is stateless, so nothing from these commands reaches
  MrHuang. The prompt is still a single `user` message, so pointing `baseUrl`
  at `http://100.117.221.48:3000/v1` with `model: "mrhuang"` and
  `apiKey: <API_TOKEN>` would work if you ever wanted that.
- **Latency:** the level scale is one extra model call. With reasoning on it
  took ~95 s on the live box, which is why the default `scaleExtraBody` turns
  thinking off for that call only; the command itself keeps full reasoning
  (~17 s measured). The scale is cached per chat until a new message arrives
  or `scaleTtlMs` passes.
- `levels: null` (or omit it) makes a one-click command. `levels: 10` is
  shorthand for a 10-step evolving scale.
- The LLM API key and the local API token never reach the renderer; the UI
  only gets `{id, label, symbol, pinned, levels, autoSend}` per command.

## How a command runs

1. UI → IPC `ai-commands:run` (commandId, conversationId, level).
2. Main process reads the newest `contextMessages` visible messages of that
   chat straight from the SQLCipher DB (`getOlderMessagesByConversation`),
   resolves sender names from the conversations table, and renders a plain
   transcript (oldest first, attachments as `[photo]`, quotes and reactions
   inline), trimmed to `context.maxChars`.
3. If the command has levels, the **level scale** is fetched (cached per
   chat+command, invalidated by a new last message or `scaleTtlMs`): one
   model call asking for exactly N `{level, title, description}` objects
   grounded in the transcript. A malformed reply falls back to a generic
   scale and the picker footer says so.
4. One model call builds the message (`buildCommandPrompt`), `<think>` blocks
   and wrapping quotes/fences are stripped, and the text is put into the
   composer (`autoSend: true` submits it).

Logs (`ai-commands` logger) are body-free: prompt/output lengths, durations,
message counts, status codes.

## Local API

Base `http://127.0.0.1:7474/v1`, auth `Authorization: Bearer <token>` or
`?token=`. JSON in, JSON out. The token is in the config file.

| Method | Path                                   | Notes                                                                                                               |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                              | `{ok:true}`                                                                                                         |
| GET    | `/conversations`                       | active conversations, newest first                                                                                  |
| GET    | `/conversations/:id`                   | summary (title, type, members, unread)                                                                              |
| GET    | `/conversations/:id/messages?limit=50` | newest `limit` (≤500) visible messages, oldest first                                                                |
| GET    | `/active?limit=50`                     | the chat currently open in the window + its messages                                                                |
| GET    | `/commands`                            | presets (no secrets)                                                                                                |
| GET    | `/commands/:id/scale?conversationId=`  | the evolving level scale (defaults to the open chat)                                                                |
| POST   | `/commands/:id/run`                    | `{conversationId?, level?, insert?, send?}` → `{text, durationMs, composed}`; `insert` drafts it, `send` submits it |
| POST   | `/compose`                             | `{conversationId?, text, send?}` → puts text in the composer of that chat                                           |

```sh
TOKEN=$(jq -r .localApi.token ~/.config/Signal-development/ai-commands.json)
curl -s -H "Authorization: Bearer $TOKEN" localhost:7474/v1/active | jq '.conversation.title, (.messages|length)'
curl -s -H "Authorization: Bearer $TOKEN" -X POST localhost:7474/v1/commands/insult-sean/run \
  -H 'content-type: application/json' -d '{"level": 7, "insert": true}'
```

Message shape: `{id, conversationId, timestamp, receivedAt, direction,
senderId, senderName, body, attachments:[{contentType,fileName}], quoteText,
reactions:[emoji]}`.

**Security:** the API is read-mostly (the only writes are "put text in the
composer" and "submit it") but it exposes every message this client holds to
anything on the machine that has the token. Keep `host` on loopback. The
token is compared in constant time; bodies are capped at 64 KB.

## Running

```sh
pnpm install && pnpm run generate   # once (and after pulling)
pnpm start                           # dev instance → ~/.config/Signal-development
```

The dev instance is a separate "linked device": link it from your phone like a
new desktop. It does **not** touch the data of an installed Signal Desktop.
For a packaged build use `pnpm run build` (electron-builder) — note the fork
tracks upstream `main`, which may be ahead of the released client's DB
schema, so don't point a packaged fork at an existing `~/.config/Signal`
profile unless you're fine with the official client refusing to open it
afterwards.

## Tests

```sh
pnpm run test-node -- --grep ai_commands
```

Covers transcript building/trimming, scale parsing + fallbacks, reply
cleaning, config normalization (clamps, dedupe, secret stripping, unreadable
file) and the API router (auth-free routing layer: status codes, active-chat
resolution, level validation, compose forwarding).
