import { describe, expect, it } from 'vitest';

import {
  NormalizationError,
  conversationKindFrom,
  extractMentionedUserIds,
  isNonContentMessage,
  mentionsUser,
  normalizeConversation,
  normalizeMessage,
  normalizeMessageEvent,
  normalizeUser,
  parseSlackTs,
  userDisplayLabel,
} from '@/lib/slack/normalize';
import type {
  RawSlackConversation,
  RawSlackMessage,
  RawSlackUser,
} from '@/lib/slack/raw';

/**
 * Normalization tests (plan.md Phase 1, verification #2).
 *
 * Every fixture below is a trimmed but otherwise verbatim payload shape from
 * the real BOOM workspace or from Slack's documented examples. Nothing here
 * touches the network or the DB — that is the point: normalization has to be
 * checkable without a live workspace.
 */

const CONVERSATION = 'D0BKMJLRRNH';

/** A plain human DM, as `conversations.history` returns it. */
function plainMessage(overrides: Partial<RawSlackMessage> = {}): RawSlackMessage {
  return {
    type: 'message',
    user: 'U0BEHBXNGHK',
    ts: '1784938592.138359',
    text: 'hello',
    team: 'T0BEJLG8H1U',
    blocks: [
      {
        type: 'rich_text',
        block_id: 'ZL1yL',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: 'hello' }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('parseSlackTs', () => {
  it('converts seconds.microseconds to an instant', () => {
    expect(parseSlackTs('1784938592.138359').toISOString()).toBe(
      '2026-07-25T00:16:32.138Z',
    );
  });

  it('handles a whole-second ts with no fraction', () => {
    expect(parseSlackTs('1784938592').getTime()).toBe(1784938592000);
  });

  it('pads a short fraction rather than misreading it as milliseconds', () => {
    // ".5" is half a second, i.e. 500ms — not 5ms.
    expect(parseSlackTs('1000000000.5').getTime()).toBe(1000000000500);
  });

  it('is exact at microsecond precision that float maths rounds wrong', () => {
    // Number('1784938592.138359') * 1000 lands on ...138.3590087890625 and can
    // round the millisecond the wrong way; the string split cannot.
    expect(parseSlackTs('1784938592.138999').getMilliseconds()).toBe(138);
  });

  it('throws on garbage rather than producing an Invalid Date', () => {
    expect(() => parseSlackTs('not-a-ts')).toThrow(NormalizationError);
  });
});

describe('extractMentionedUserIds', () => {
  it('finds a bare mention', () => {
    expect(extractMentionedUserIds('hey <@U0BK9FR4Y1M> look')).toEqual([
      'U0BK9FR4Y1M',
    ]);
  });

  it('finds a mention carrying a display label', () => {
    expect(extractMentionedUserIds('<@U0BK9FR4Y1M|aditya> ping')).toEqual([
      'U0BK9FR4Y1M',
    ]);
  });

  it('dedupes and preserves order of first appearance', () => {
    expect(
      extractMentionedUserIds('<@U222> <@U111> then <@U222> again'),
    ).toEqual(['U222', 'U111']);
  });

  it('matches Enterprise Grid W-prefixed ids', () => {
    expect(extractMentionedUserIds('<@W012ABCDE>')).toEqual(['W012ABCDE']);
  });

  it('ignores channel and here broadcasts, which are not user mentions', () => {
    expect(extractMentionedUserIds('<!here> <!channel> <!everyone>')).toEqual(
      [],
    );
  });

  it('ignores channel links, which use the same angle-bracket syntax', () => {
    expect(extractMentionedUserIds('see <#C0BEEDB94D9|random>')).toEqual([]);
  });

  it('returns empty for undefined text', () => {
    expect(extractMentionedUserIds(undefined)).toEqual([]);
  });

  it('mentionsUser answers for a specific id', () => {
    expect(mentionsUser('<@U0BK9FR4Y1M>', 'U0BK9FR4Y1M')).toBe(true);
    expect(mentionsUser('<@U0BEHBXNGHK>', 'U0BK9FR4Y1M')).toBe(false);
  });
});

describe('normalizeMessage', () => {
  it('normalizes a plain human message', () => {
    const message = normalizeMessage(plainMessage(), CONVERSATION);

    expect(message).toMatchObject({
      conversationId: CONVERSATION,
      ts: '1784938592.138359',
      userId: 'U0BEHBXNGHK',
      botId: null,
      subtype: null,
      text: 'hello',
      teamId: 'T0BEJLG8H1U',
      isEdited: false,
      editedAt: null,
      isThreadReply: false,
      isThreadParent: false,
      replyCount: 0,
      reactions: null,
      hasFiles: false,
      mentionedUserIds: [],
    });
    expect(message.sentAt.toISOString()).toBe('2026-07-25T00:16:32.138Z');
    expect(message.blocks).toHaveLength(1);
  });

  it('throws when the message has no ts, since it could not be deduped', () => {
    expect(() => normalizeMessage({ text: 'x' }, CONVERSATION)).toThrow(
      NormalizationError,
    );
  });

  it('defaults missing text to empty string instead of null', () => {
    // File-only messages arrive with no `text` at all.
    const message = normalizeMessage(
      { ts: '1784938592.000100', user: 'U1', files: [{ id: 'F1' }] },
      CONVERSATION,
    );
    expect(message.text).toBe('');
    expect(message.hasFiles).toBe(true);
  });

  it('records mentions found in the text', () => {
    const message = normalizeMessage(
      plainMessage({ text: 'ping <@U0BK9FR4Y1M> and <@U0BEHBXNGHK>' }),
      'C0BFRLH0SDU',
    );
    expect(message.mentionedUserIds).toEqual(['U0BK9FR4Y1M', 'U0BEHBXNGHK']);
  });

  // --- Edge case 1 required by plan.md: threaded reply --------------------

  it('marks a thread parent (thread_ts equals ts) and keeps its reply count', () => {
    const parent = normalizeMessage(
      plainMessage({
        ts: '1784938592.138359',
        thread_ts: '1784938592.138359',
        reply_count: 3,
      }),
      CONVERSATION,
    );

    expect(parent.isThreadParent).toBe(true);
    expect(parent.isThreadReply).toBe(false);
    expect(parent.threadTs).toBe('1784938592.138359');
    expect(parent.replyCount).toBe(3);
  });

  it('marks a threaded reply (thread_ts differs from ts) and points at the parent', () => {
    const reply = normalizeMessage(
      plainMessage({
        ts: '1784938700.221100',
        thread_ts: '1784938592.138359',
        text: 'replying in thread',
      }),
      CONVERSATION,
    );

    expect(reply.isThreadReply).toBe(true);
    expect(reply.isThreadParent).toBe(false);
    expect(reply.threadTs).toBe('1784938592.138359');
  });

  it('does not trust reply_count on a reply', () => {
    // Slack echoes the thread's reply_count onto broadcast replies; storing it
    // there would make one thread look like several.
    const reply = normalizeMessage(
      plainMessage({
        ts: '1784938700.221100',
        thread_ts: '1784938592.138359',
        subtype: 'thread_broadcast',
        reply_count: 3,
      }),
      CONVERSATION,
    );

    expect(reply.isThreadReply).toBe(true);
    expect(reply.replyCount).toBe(0);
  });

  it('treats a message with no thread_ts as standalone', () => {
    const message = normalizeMessage(plainMessage(), CONVERSATION);
    expect(message.threadTs).toBeNull();
    expect(message.isThreadParent).toBe(false);
    expect(message.isThreadReply).toBe(false);
  });

  // --- Edge case 2 required by plan.md: edited message --------------------

  it('flags an edited message and records when it was edited', () => {
    // Verbatim shape from the BOOM #random channel.
    const message = normalizeMessage(
      {
        ts: '1783555641.826069',
        bot_id: 'B0BFXHAS7J7',
        subtype: 'bot_message',
        text: ':hourglass_flowing_sand: Approval needed — Approved',
        edited: { user: 'B0BFXHAS7J7', ts: '1783555644.000000' },
      },
      'C0BEEDB94D9',
    );

    expect(message.isEdited).toBe(true);
    expect(message.editedAt?.toISOString()).toBe('2026-07-09T00:07:24.000Z');
    // The edit must not disturb the message's own identity or ordering key.
    expect(message.ts).toBe('1783555641.826069');
    expect(message.sentAt.toISOString()).toBe('2026-07-09T00:07:21.826Z');
  });

  it('still flags an edit when Slack sends an edited block with no ts', () => {
    const message = normalizeMessage(
      plainMessage({ edited: {} }),
      CONVERSATION,
    );
    expect(message.isEdited).toBe(true);
    expect(message.editedAt).toBeNull();
  });

  // --- Edge case 3 required by plan.md: reactions -------------------------

  it('normalizes reactions, renaming users -> userIds', () => {
    const message = normalizeMessage(
      plainMessage({
        reactions: [
          { name: 'eyes', count: 1, users: ['U0BK9FR4Y1M'] },
          {
            name: 'white_check_mark',
            count: 2,
            users: ['U0BK9FR4Y1M', 'U0BEHBXNGHK'],
          },
        ],
      }),
      CONVERSATION,
    );

    expect(message.reactions).toEqual([
      { name: 'eyes', count: 1, userIds: ['U0BK9FR4Y1M'] },
      {
        name: 'white_check_mark',
        count: 2,
        userIds: ['U0BK9FR4Y1M', 'U0BEHBXNGHK'],
      },
    ]);
  });

  it('sorts reactions by name so re-ingesting the same data is a no-op', () => {
    const message = normalizeMessage(
      plainMessage({
        reactions: [
          { name: 'zap', count: 1, users: ['U1'] },
          { name: 'apple', count: 1, users: ['U2'] },
        ],
      }),
      CONVERSATION,
    );

    expect(message.reactions?.map((r) => r.name)).toEqual(['apple', 'zap']);
  });

  it('keeps Slack’s count when it exceeds the truncated user list', () => {
    const message = normalizeMessage(
      plainMessage({ reactions: [{ name: 'tada', count: 57, users: ['U1'] }] }),
      CONVERSATION,
    );
    expect(message.reactions?.[0]).toEqual({
      name: 'tada',
      count: 57,
      userIds: ['U1'],
    });
  });

  it('falls back to the user list length when count is missing', () => {
    const message = normalizeMessage(
      plainMessage({ reactions: [{ name: 'tada', users: ['U1', 'U2'] }] }),
      CONVERSATION,
    );
    expect(message.reactions?.[0].count).toBe(2);
  });

  it('dedupes repeated users within one reaction', () => {
    const message = normalizeMessage(
      plainMessage({ reactions: [{ name: 'tada', users: ['U1', 'U1'] }] }),
      CONVERSATION,
    );
    expect(message.reactions?.[0].userIds).toEqual(['U1']);
  });

  it('uses null, not an empty array, when there are no reactions', () => {
    expect(
      normalizeMessage(plainMessage({ reactions: [] }), CONVERSATION).reactions,
    ).toBeNull();
  });

  // --- Bot and subtype handling ------------------------------------------

  it('normalizes a classic bot message that has no user id', () => {
    const message = normalizeMessage(
      {
        ts: '1783555728.181709',
        bot_id: 'B0BFXHAS7J7',
        subtype: 'bot_message',
        username: 'Ops Bot',
        text: ':rotating_light: Agent hit a problem',
      },
      'C0BEEDB94D9',
    );

    expect(message.userId).toBeNull();
    expect(message.botId).toBe('B0BFXHAS7J7');
    expect(message.authorName).toBe('Ops Bot');
    expect(message.subtype).toBe('bot_message');
  });

  it('falls back to bot_profile for a bot’s id and name', () => {
    const message = normalizeMessage(
      {
        ts: '1783555728.181709',
        bot_profile: { id: 'B999', name: 'Welcome Bot' },
        text: 'hi',
      },
      'C0BEEDB94D9',
    );
    expect(message.botId).toBe('B999');
    expect(message.authorName).toBe('Welcome Bot');
  });

  it('flags membership noise as non-content but still normalizes it', () => {
    const join = normalizeMessage(
      {
        ts: '1784938466.737889',
        user: 'U0BK9FR4Y1M',
        subtype: 'channel_join',
        text: '<@U0BK9FR4Y1M> has joined the channel',
      },
      'C0BELLTP5FU',
    );

    expect(join.subtype).toBe('channel_join');
    expect(isNonContentMessage(join)).toBe(true);
    expect(isNonContentMessage(normalizeMessage(plainMessage(), CONVERSATION))).toBe(
      false,
    );
  });
});

describe('normalizeMessageEvent', () => {
  it('treats an ordinary message event as an upsert', () => {
    const result = normalizeMessageEvent({
      type: 'message',
      channel: CONVERSATION,
      channel_type: 'im',
      user: 'U0BEHBXNGHK',
      ts: '1784938592.138359',
      text: 'hello',
    });

    expect(result.kind).toBe('upsert');
    if (result.kind !== 'upsert') return;
    expect(result.message.conversationId).toBe(CONVERSATION);
    expect(result.message.ts).toBe('1784938592.138359');
  });

  it('unwraps message_changed and uses the inner message, not the envelope', () => {
    // The envelope's own ts is the *event* time. Using it would create a
    // second row for a message that already exists.
    const result = normalizeMessageEvent({
      type: 'message',
      subtype: 'message_changed',
      channel: CONVERSATION,
      ts: '1784999999.000000',
      message: {
        ts: '1784938592.138359',
        user: 'U0BEHBXNGHK',
        text: 'hello (edited)',
        edited: { user: 'U0BEHBXNGHK', ts: '1784999999.000000' },
      },
      previous_message: { ts: '1784938592.138359', text: 'hello' },
    });

    expect(result.kind).toBe('upsert');
    if (result.kind !== 'upsert') return;
    expect(result.message.ts).toBe('1784938592.138359');
    expect(result.message.text).toBe('hello (edited)');
    expect(result.message.isEdited).toBe(true);
  });

  it('treats message_deleted as a deletion of the previous ts', () => {
    const result = normalizeMessageEvent({
      type: 'message',
      subtype: 'message_deleted',
      channel: CONVERSATION,
      ts: '1784999999.000000',
      deleted_ts: '1784938592.138359',
      previous_message: { ts: '1784938592.138359', text: 'hello' },
    });

    expect(result).toEqual({
      kind: 'delete',
      conversationId: CONVERSATION,
      ts: '1784938592.138359',
    });
  });

  it('falls back to previous_message.ts when deleted_ts is absent', () => {
    const result = normalizeMessageEvent({
      type: 'message',
      subtype: 'message_deleted',
      channel: CONVERSATION,
      previous_message: { ts: '1784938592.138359' },
    });
    expect(result).toMatchObject({ kind: 'delete', ts: '1784938592.138359' });
  });

  it('treats a tombstone inside message_changed as a deletion', () => {
    const result = normalizeMessageEvent({
      type: 'message',
      subtype: 'message_changed',
      channel: CONVERSATION,
      message: { ts: '1784938592.138359', subtype: 'tombstone', text: '' },
    });
    expect(result).toMatchObject({ kind: 'delete', ts: '1784938592.138359' });
  });

  it('picks up a refreshed reply_count from message_replied', () => {
    const result = normalizeMessageEvent({
      type: 'message',
      subtype: 'message_replied',
      channel: CONVERSATION,
      hidden: true,
      message: {
        ts: '1784938592.138359',
        thread_ts: '1784938592.138359',
        reply_count: 2,
        text: 'parent',
      },
    });

    expect(result.kind).toBe('upsert');
    if (result.kind !== 'upsert') return;
    expect(result.message.isThreadParent).toBe(true);
    expect(result.message.replyCount).toBe(2);
  });

  it('ignores an event with no channel', () => {
    expect(normalizeMessageEvent({ ts: '1.0' })).toMatchObject({
      kind: 'ignore',
    });
  });

  it('ignores an event with no ts', () => {
    expect(
      normalizeMessageEvent({ channel: CONVERSATION, text: 'x' }),
    ).toMatchObject({ kind: 'ignore' });
  });

  it('ignores message_changed with no nested message', () => {
    expect(
      normalizeMessageEvent({
        subtype: 'message_changed',
        channel: CONVERSATION,
        ts: '1.0',
      }),
    ).toMatchObject({ kind: 'ignore' });
  });
});

describe('normalizeConversation', () => {
  it('normalizes an IM and keeps the peer user id', () => {
    // Verbatim shape from conversations.list in BOOM.
    const raw: RawSlackConversation = {
      id: 'D0BKMJLRRNH',
      is_im: true,
      user: 'U0BEHBXNGHK',
      is_archived: false,
    };

    expect(normalizeConversation(raw)).toEqual({
      id: 'D0BKMJLRRNH',
      kind: 'IM',
      name: null,
      peerUserId: 'U0BEHBXNGHK',
      topic: null,
      purpose: null,
      isArchived: false,
      isMember: false,
      teamId: null,
    });
  });

  it('normalizes a public channel', () => {
    const raw: RawSlackConversation = {
      id: 'C0BEEDB94D9',
      name: 'random',
      is_channel: true,
      is_private: false,
      is_member: true,
      topic: { value: 'Non-work banter' },
      purpose: { value: '' },
    };

    expect(normalizeConversation(raw)).toMatchObject({
      kind: 'PUBLIC_CHANNEL',
      name: 'random',
      isMember: true,
      topic: 'Non-work banter',
      // Slack sends "" for an unset purpose; that must become null, not "".
      purpose: null,
      peerUserId: null,
    });
  });

  it('does not treat channel.user as a peer on a non-IM', () => {
    const raw: RawSlackConversation = {
      id: 'C123',
      is_channel: true,
      user: 'U_CREATOR',
    };
    expect(normalizeConversation(raw).peerUserId).toBeNull();
  });

  it('throws when the conversation has no id', () => {
    expect(() => normalizeConversation({ name: 'x' })).toThrow(
      NormalizationError,
    );
  });

  describe('conversationKindFrom', () => {
    it('prefers Slack’s own flags', () => {
      expect(conversationKindFrom({ id: 'C1', is_mpim: true })).toBe('MPIM');
      expect(
        conversationKindFrom({ id: 'C1', is_channel: true, is_private: true }),
      ).toBe('PRIVATE_CHANNEL');
      expect(conversationKindFrom({ id: 'G1', is_group: true })).toBe(
        'PUBLIC_CHANNEL',
      );
    });

    it('falls back to the id prefix when flags are absent', () => {
      // search.messages returns a thinner channel object than
      // conversations.list, often with none of the is_* booleans set.
      expect(conversationKindFrom({ id: 'D0BKMJLRRNH' })).toBe('IM');
      expect(conversationKindFrom({ id: 'C0BFRLH0SDU' })).toBe(
        'PUBLIC_CHANNEL',
      );
      expect(conversationKindFrom({ id: 'G0000000000' })).toBe(
        'PRIVATE_CHANNEL',
      );
    });

    it('returns UNKNOWN rather than guessing on an unrecognized id', () => {
      expect(conversationKindFrom({ id: 'X123' })).toBe('UNKNOWN');
      expect(conversationKindFrom({})).toBe('UNKNOWN');
    });
  });
});

describe('normalizeUser', () => {
  it('normalizes a human member', () => {
    const raw: RawSlackUser = {
      id: 'U0BK9FR4Y1M',
      team_id: 'T0BEJLG8H1U',
      name: 'adityaneni24_alt',
      tz: 'America/New_York',
      deleted: false,
      is_bot: false,
      profile: {
        real_name: 'Aditya Alt',
        display_name: 'aditya',
        image_72: 'https://example.invalid/a.png',
      },
    };

    expect(normalizeUser(raw)).toEqual({
      id: 'U0BK9FR4Y1M',
      teamId: 'T0BEJLG8H1U',
      username: 'adityaneni24_alt',
      realName: 'Aditya Alt',
      displayName: 'aditya',
      avatarUrl: 'https://example.invalid/a.png',
      timezone: 'America/New_York',
      isBot: false,
      isDeleted: false,
    });
  });

  it('normalizes a bot member with an empty display name', () => {
    const user = normalizeUser({
      id: 'U0BFC9J9KP1',
      name: 'welcome_bot_dev',
      is_bot: true,
      profile: { real_name: 'Welcome Bot Dev', display_name: '' },
    });

    expect(user.isBot).toBe(true);
    expect(user.displayName).toBeNull();
    expect(userDisplayLabel(user)).toBe('Welcome Bot Dev');
  });

  it('throws when the user has no id', () => {
    expect(() => normalizeUser({ name: 'x' })).toThrow(NormalizationError);
  });

  it('userDisplayLabel degrades to the id when nothing else is known', () => {
    expect(
      userDisplayLabel({
        id: 'U999',
        teamId: null,
        username: null,
        realName: null,
        displayName: null,
        avatarUrl: null,
        timezone: null,
        isBot: false,
        isDeleted: false,
      }),
    ).toBe('U999');
  });
});
