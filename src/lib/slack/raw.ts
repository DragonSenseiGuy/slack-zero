/**
 * Structural types for the bits of Slack's payloads we actually read.
 *
 * These exist so the ingestion boundary has a *narrow*, explicit contract
 * instead of accepting `@slack/web-api`'s enormous generated result types.
 * Two reasons:
 *
 * 1. CLAUDE.md requires Slack response shapes not leak past normalization.
 *    Naming the handful of fields we depend on makes "what Slack gives us"
 *    auditable in one file.
 * 2. Slack's own types declare nearly everything optional and index-signature
 *    the rest, so passing them around gives no real safety. Fixtures in tests
 *    can satisfy these types directly, which is what lets the normalization
 *    tests run with no live Slack.
 *
 * Everything is optional and readonly: Slack omits fields freely, and a
 * missing field must never be a crash.
 */

/** `{ user, ts }` — present only when a message has been edited. */
export type RawEdited = {
  readonly user?: string;
  readonly ts?: string;
};

/** One reaction bucket as Slack reports it. */
export type RawReaction = {
  readonly name?: string;
  readonly count?: number;
  readonly users?: readonly string[];
};

/** Slack's `bot_profile`, used for a display name on bot messages. */
export type RawBotProfile = {
  readonly id?: string;
  readonly name?: string;
};

/**
 * A message as returned by `conversations.history` / `conversations.replies`,
 * or delivered inside a `message` event.
 */
export type RawSlackMessage = {
  readonly type?: string;
  readonly subtype?: string;
  readonly ts?: string;
  readonly text?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly username?: string;
  readonly bot_profile?: RawBotProfile;
  readonly team?: string;
  readonly thread_ts?: string;
  readonly reply_count?: number;
  readonly edited?: RawEdited;
  readonly reactions?: readonly RawReaction[];
  readonly files?: readonly unknown[];
  /**
   * Block Kit payload. Stored verbatim, never interpreted here, hence
   * `unknown[]`.
   */
  readonly blocks?: readonly unknown[];
  /** Present on `message_changed`/`message_deleted` event wrappers. */
  readonly channel?: string;
  readonly message?: RawSlackMessage;
  readonly previous_message?: RawSlackMessage;
  readonly deleted_ts?: string;
  readonly hidden?: boolean;
  readonly channel_type?: string;
};

/** A conversation as returned by `conversations.list` / `conversations.info`. */
export type RawSlackConversation = {
  readonly id?: string;
  readonly name?: string;
  readonly is_im?: boolean;
  readonly is_mpim?: boolean;
  readonly is_group?: boolean;
  readonly is_channel?: boolean;
  readonly is_private?: boolean;
  readonly is_archived?: boolean;
  readonly is_member?: boolean;
  /** Present on `conversations.info` for DMs despite being absent from the SDK type. */
  readonly last_read?: string;
  readonly latest?: RawSlackMessage;
  readonly unread_count?: number;
  readonly unread_count_display?: number;
  /** On an IM, the Slack id of the other party. */
  readonly user?: string;
  readonly context_team_id?: string;
  readonly shared_team_ids?: readonly string[];
  readonly topic?: { readonly value?: string };
  readonly purpose?: { readonly value?: string };
};

/** A member as returned by `users.list` / `users.info`. */
export type RawSlackUser = {
  readonly id?: string;
  readonly team_id?: string;
  readonly name?: string;
  readonly deleted?: boolean;
  readonly is_bot?: boolean;
  readonly tz?: string;
  readonly profile?: {
    readonly real_name?: string;
    readonly display_name?: string;
    readonly image_72?: string;
  };
};

/** A `reaction_added` / `reaction_removed` event payload. */
export type RawReactionEvent = {
  readonly type?: string;
  readonly user?: string;
  readonly reaction?: string;
  readonly item?: {
    readonly type?: string;
    readonly channel?: string;
    readonly ts?: string;
  };
};
