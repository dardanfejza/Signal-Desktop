// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Read-only view over this client's conversations and messages, built on the
// main-process SQL handle. Nothing here writes.

import type { MainSQL } from '../../ts/sql/main.main.ts';
import type {
  ConversationAttributesType,
  MessageAttributesType,
} from '../../ts/model-types.d.ts';
import type { TranscriptMessage } from './prompts.std.ts';

export type ConversationSummary = Readonly<{
  id: string;
  type: 'group' | 'direct' | 'note-to-self';
  title: string;
  isGroup: boolean;
  memberCount: number | null;
  members: ReadonlyArray<string> | null;
  activeAt: number | null;
  unreadCount: number;
  isArchived: boolean;
}>;

export type NormalizedMessage = TranscriptMessage &
  Readonly<{
    id: string;
    conversationId: string;
    receivedAt: number;
    senderId: string | null;
    attachments: ReadonlyArray<
      Readonly<{ contentType: string; fileName: string | null }>
    >;
  }>;

type Directory = Readonly<{
  loadedAt: number;
  all: ReadonlyArray<ConversationAttributesType>;
  byId: ReadonlyMap<string, ConversationAttributesType>;
  byServiceId: ReadonlyMap<string, ConversationAttributesType>;
  byE164: ReadonlyMap<string, ConversationAttributesType>;
  ourAci: string | null;
}>;

const DIRECTORY_TTL_MS = 30_000;

function joinName(...parts: Array<string | null | undefined>): string {
  return parts
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
}

function displayNameOf(
  conversation: ConversationAttributesType | undefined,
  fallback = 'Unknown'
): string {
  if (!conversation) {
    return fallback;
  }
  if (conversation.type === 'group') {
    return conversation.name?.trim() || 'Unnamed group';
  }
  return (
    conversation.systemNickname?.trim() ||
    joinName(conversation.nicknameGivenName, conversation.nicknameFamilyName) ||
    joinName(conversation.systemGivenName, conversation.systemFamilyName) ||
    joinName(conversation.profileName, conversation.profileFamilyName) ||
    conversation.name?.trim() ||
    conversation.e164 ||
    fallback
  );
}

export class ConversationContext {
  readonly #sql: MainSQL;

  #directory: Directory | undefined;

  #directoryPromise: Promise<Directory> | undefined;

  constructor(sql: MainSQL) {
    this.#sql = sql;
  }

  invalidate(): void {
    this.#directory = undefined;
  }

  async #getDirectory(): Promise<Directory> {
    const cached = this.#directory;
    if (cached && Date.now() - cached.loadedAt < DIRECTORY_TTL_MS) {
      return cached;
    }
    if (this.#directoryPromise) {
      return this.#directoryPromise;
    }
    this.#directoryPromise = (async () => {
      const [all, uuidItem] = await Promise.all([
        this.#sql.sqlRead('getAllConversations'),
        this.#sql.sqlRead('getItemById', 'uuid_id'),
      ]);
      const ourAci = extractAci(uuidItem);
      const byId = new Map<string, ConversationAttributesType>();
      const byServiceId = new Map<string, ConversationAttributesType>();
      const byE164 = new Map<string, ConversationAttributesType>();
      for (const conversation of all) {
        byId.set(conversation.id, conversation);
        if (conversation.serviceId) {
          byServiceId.set(conversation.serviceId, conversation);
        }
        if (conversation.pni) {
          byServiceId.set(conversation.pni, conversation);
        }
        if (conversation.e164) {
          byE164.set(conversation.e164, conversation);
        }
      }
      const directory: Directory = {
        loadedAt: Date.now(),
        all,
        byId,
        byServiceId,
        byE164,
        ourAci,
      };
      this.#directory = directory;
      return directory;
    })();
    try {
      return await this.#directoryPromise;
    } finally {
      this.#directoryPromise = undefined;
    }
  }

  async getMyName(): Promise<string> {
    const directory = await this.#getDirectory();
    const me = directory.ourAci
      ? directory.byServiceId.get(directory.ourAci)
      : undefined;
    return displayNameOf(me, 'Me');
  }

  async listConversations(): Promise<Array<ConversationSummary>> {
    const directory = await this.#getDirectory();
    return directory.all
      .filter(conversation => conversation.active_at)
      .map(conversation => this.#summarize(conversation, directory))
      .sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
  }

  async getConversation(id: string): Promise<ConversationSummary | undefined> {
    const directory = await this.#getDirectory();
    let conversation = directory.byId.get(id);
    if (!conversation) {
      // Might be newer than the cached directory.
      conversation = await this.#sql.sqlRead('getConversationById', id);
      if (!conversation) {
        return undefined;
      }
      this.invalidate();
    }
    return this.#summarize(conversation, directory);
  }

  #summarize(
    conversation: ConversationAttributesType,
    directory: Directory
  ): ConversationSummary {
    const isGroup = conversation.type === 'group';
    const isNoteToSelf =
      !isGroup &&
      directory.ourAci != null &&
      conversation.serviceId === directory.ourAci;
    const memberAcis = isGroup
      ? (conversation.membersV2?.map(member => member.aci) ??
        conversation.members ??
        [])
      : null;
    const members = memberAcis
      ? memberAcis.map(aci =>
          displayNameOf(
            directory.byServiceId.get(aci) ?? directory.byId.get(aci),
            aci === directory.ourAci ? 'Me' : 'Unknown'
          )
        )
      : null;
    let type: ConversationSummary['type'] = 'direct';
    if (isGroup) {
      type = 'group';
    } else if (isNoteToSelf) {
      type = 'note-to-self';
    }
    return {
      id: conversation.id,
      type,
      title: isNoteToSelf ? 'Note to Self' : displayNameOf(conversation),
      isGroup,
      memberCount: members ? members.length : null,
      members,
      activeAt: conversation.active_at ?? null,
      unreadCount: conversation.unreadCount ?? 0,
      isArchived: Boolean(conversation.isArchived),
    };
  }

  /** Newest `limit` visible messages, returned oldest-first. */
  async getRecentMessages(
    conversationId: string,
    limit: number
  ): Promise<Array<NormalizedMessage>> {
    const directory = await this.#getDirectory();
    const myName = await this.getMyName();
    // Over-fetch a little: service messages (group changes, timer updates…)
    // are filtered out below.
    const rows = await this.#sql.sqlRead('getOlderMessagesByConversation', {
      conversationId,
      limit: Math.min(1000, Math.ceil(limit * 1.5) + 5),
      includeStoryReplies: false,
      storyId: undefined,
    });
    const normalized: Array<NormalizedMessage> = [];
    for (const row of rows) {
      const message = normalizeMessage(row, directory, myName);
      if (message) {
        normalized.push(message);
      }
    }
    normalized.sort(
      (a, b) => a.receivedAt - b.receivedAt || a.timestamp - b.timestamp
    );
    return normalized.slice(-limit);
  }
}

function extractAci(item: unknown): string | null {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const value = (item as { value?: unknown }).value;
  if (typeof value !== 'string') {
    return null;
  }
  // Stored as "<aci>.<deviceId>".
  return value.split('.')[0] || null;
}

function normalizeMessage(
  row: MessageAttributesType,
  directory: Directory,
  myName: string
): NormalizedMessage | undefined {
  if (row.type !== 'incoming' && row.type !== 'outgoing') {
    return undefined;
  }
  if (row.deletedForEveryone || row.isErased || row.storyId) {
    return undefined;
  }
  const attachments = (row.attachments ?? []).map(attachment => ({
    contentType: String(attachment.contentType ?? 'application/octet-stream'),
    fileName: attachment.fileName ?? null,
  }));
  if (row.sticker) {
    attachments.push({ contentType: 'image/sticker', fileName: null });
  }
  const body = row.body ?? '';
  if (!body.trim() && attachments.length === 0) {
    return undefined;
  }

  const isOutgoing = row.type === 'outgoing';
  const senderId = isOutgoing
    ? directory.ourAci
    : (row.sourceServiceId ?? row.source ?? null);
  let senderName = myName;
  if (!isOutgoing) {
    const sender =
      (row.sourceServiceId
        ? directory.byServiceId.get(row.sourceServiceId)
        : undefined) ??
      (row.source ? directory.byE164.get(row.source) : undefined);
    senderName = displayNameOf(sender, row.source ?? 'Unknown');
  }

  const reactions = (row.reactions ?? [])
    .map(reaction => (reaction.emoji ? String(reaction.emoji) : ''))
    .filter(Boolean);

  return {
    id: row.id,
    conversationId: row.conversationId,
    timestamp: row.sent_at,
    receivedAt: row.received_at,
    direction: isOutgoing ? 'outgoing' : 'incoming',
    senderId,
    senderName,
    body,
    attachments,
    quoteText: row.quote?.text?.trim() || null,
    reactions,
  };
}
