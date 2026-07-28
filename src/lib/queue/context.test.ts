import { describe, expect, it } from 'vitest';

import {
  buildContextPage,
  CONTEXT_PAGE_SIZE,
  InvalidContextRequestError,
  isContextWorthy,
  MAX_CONTEXT_PAGE_SIZE,
  parseContextRequest,
  toContextMessage,
  type ContextMessageRow,
} from '@/lib/queue/context';
import type { QueueConversation, QueueUser } from '@/lib/queue/queue';

const ME = 'U0BK9FR4Y1M';
const PEER = 'U0BEHBXNGHK';

const IM: QueueConversation = {
  id: 'D0BKMJLRRNH',
  kind: 'IM',
  name: null,
  peerUserId: PEER,
};

const USERS = new Map<string, QueueUser>([
  [
    ME,
    {
      id: ME,
      username: 'aditya',
      realName: 'Aditya N',
      displayName: 'adi',
      avatarUrl: null,
      isBot: false,
      isVip: false,
    },
  ],
  [
    PEER,
    {
      id: PEER,
      username: 'dsg',
      realName: 'Dragon Sensei Guy',
      displayName: '',
      avatarUrl: 'https://example.com/dsg.png',
      isBot: false,
      isVip: false,
    },
  ],
]);

const CONVERSATIONS = new Map<string, QueueConversation>([[IM.id, IM]]);

let counter = 0;

function row(overrides: Partial<ContextMessageRow> = {}): ContextMessageRow {
  counter += 1;
  return {
    id: `m${counter}`,
    ts: `178493859${counter}.000100`,
    sentAt: new Date(Date.UTC(2026, 6, 25, 12, counter)),
    userId: PEER,
    authorName: null,
    botId: null,
    subtype: null,
    text: 'hello',
    isEdited: false,
    isDeleted: false,
    hasFiles: false,
    ...overrides,
  };
}

describe('parseContextRequest', () => {
  const params = (query: string) => new URLSearchParams(query);

  it('defaults to a page of ten', () => {
    expect(parseContextRequest(params('before=1784938592.138359'))).toEqual({
      before: '1784938592.138359',
      limit: CONTEXT_PAGE_SIZE,
    });
  });

  it('requires a cursor', () => {
    expect(() => parseContextRequest(params(''))).toThrow(
      InvalidContextRequestError,
    );
  });

  it('rejects a cursor that is not a Slack timestamp', () => {
    expect(() => parseContextRequest(params('before=yesterday'))).toThrow(
      InvalidContextRequestError,
    );
  });

  it('rejects a limit that is not a positive integer', () => {
    expect(() =>
      parseContextRequest(params('before=1784938592.138359&limit=0')),
    ).toThrow(InvalidContextRequestError);
    expect(() =>
      parseContextRequest(params('before=1784938592.138359&limit=ten')),
    ).toThrow(InvalidContextRequestError);
  });

  // A hand-written URL must not be able to ask for the entire history.
  it('caps the limit', () => {
    expect(
      parseContextRequest(params('before=1784938592.138359&limit=5000')).limit,
    ).toBe(MAX_CONTEXT_PAGE_SIZE);
  });
});

describe('isContextWorthy', () => {
  it('skips deleted messages and membership noise', () => {
    expect(isContextWorthy(row({ isDeleted: true }))).toBe(false);
    expect(isContextWorthy(row({ subtype: 'channel_join' }))).toBe(false);
    expect(isContextWorthy(row({ subtype: 'bot_message' }))).toBe(true);
    expect(isContextWorthy(row())).toBe(true);
  });
});

describe('toContextMessage', () => {
  it('renders Slack markup with real names', () => {
    const message = toContextMessage(
      row({ text: `can <@${ME}> take a look?` }),
      USERS,
      CONVERSATIONS,
      ME,
    );

    expect(message.body).toBe('can @adi take a look?');
    expect(message.senderLabel).toBe('Dragon Sensei Guy');
    expect(message.senderAvatarUrl).toBe('https://example.com/dsg.png');
  });

  // The user's own half of the conversation is most of the context: without it
  // the transcript is a monologue.
  it('marks the authed user’s own messages', () => {
    expect(toContextMessage(row({ userId: ME }), USERS, CONVERSATIONS, ME))
      .toMatchObject({ isFromMe: true });
    expect(toContextMessage(row(), USERS, CONVERSATIONS, ME)).toMatchObject({
      isFromMe: false,
    });
  });

  it('says so rather than rendering an empty message', () => {
    expect(
      toContextMessage(
        row({ text: '', hasFiles: true }),
        USERS,
        CONVERSATIONS,
        ME,
      ).body,
    ).toBe('(file attachment)');
    expect(
      toContextMessage(row({ text: '' }), USERS, CONVERSATIONS, ME).body,
    ).toBe('(no text)');
  });
});

describe('buildContextPage', () => {
  const page = (rows: ContextMessageRow[], limit: number) =>
    buildContextPage(rows, limit, USERS, CONVERSATIONS, ME);

  it('flips the fetch order so the transcript reads into the message', () => {
    const newest = row({ text: 'third' });
    const middle = row({ text: 'second' });
    const oldest = row({ text: 'first' });

    expect(page([newest, middle, oldest], 10).messages.map((m) => m.body)).toEqual(
      ['first', 'second', 'third'],
    );
  });

  it('reports more history from the over-fetched row, and drops it', () => {
    const rows = [row(), row(), row(), row()];
    const result = page(rows, 3);

    expect(result.messages).toHaveLength(3);
    expect(result.hasMore).toBe(true);
  });

  it('reports no more history at the start of a conversation', () => {
    expect(page([row(), row()], 3)).toMatchObject({ hasMore: false });
  });

  it('is empty, not an error, when nothing came before', () => {
    expect(page([], 10)).toEqual({ messages: [], hasMore: false });
  });

  it('filters noise the query let through without counting it as history', () => {
    const result = page([row({ subtype: 'channel_join' }), row()], 10);
    expect(result.messages).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });
});
