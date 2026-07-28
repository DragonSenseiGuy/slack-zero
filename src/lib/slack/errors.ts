export type SlackFailureKind =
  | 'rate_limited'
  | 'permission'
  | 'not_found'
  | 'auth'
  | 'network'
  | 'unknown';

export type SlackFailure = {
  kind: SlackFailureKind;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
};

function extractCode(error: unknown): string {
  if (typeof error === 'string') return error.toLowerCase();

  if (typeof error === 'object' && error !== null) {
    const withData = error as {
      data?: { error?: unknown };
      message?: unknown;
      code?: unknown;
    };

    if (typeof withData.data?.error === 'string') {
      return withData.data.error.toLowerCase();
    }
    if (typeof withData.message === 'string') {
      return withData.message.toLowerCase();
    }
    if (typeof withData.code === 'string') return withData.code.toLowerCase();
  }

  return '';
}

function extractRetryAfter(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const withHeaders = error as {
    retryAfter?: unknown;
    headers?: Record<string, unknown>;
  };

  if (typeof withHeaders.retryAfter === 'number') return withHeaders.retryAfter;

  const header = withHeaders.headers?.['retry-after'];
  if (typeof header === 'string') {
    const parsed = Number(header);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof header === 'number') return header;

  return undefined;
}

export function describeSlackError(error: unknown): SlackFailure {
  const code = extractCode(error);
  const retryAfterSeconds = extractRetryAfter(error);

  if (code.includes('ratelimited') || code.includes('rate_limited')) {
    return {
      kind: 'rate_limited',
      message: retryAfterSeconds
        ? `Slack is rate limiting us. Try again in about ${Math.ceil(retryAfterSeconds)}s.`
        : 'Slack is rate limiting us. Wait a moment and try again.',
      retryable: true,
      retryAfterSeconds,
    };
  }

  if (
    code.includes('not_in_channel') ||
    code.includes('is_archived') ||
    code.includes('restricted_action') ||
    code.includes('missing_scope') ||
    code.includes('no_permission')
  ) {
    return {
      kind: 'permission',
      message: code.includes('missing_scope')
        ? 'SlackZero is missing a permission for that. Re-connect the workspace to grant it.'
        : 'Slack refused that — you may not be a member of the channel, or it is archived.',
      retryable: false,
    };
  }

  if (
    code.includes('channel_not_found') ||
    code.includes('message_not_found') ||
    code.includes('thread_not_found')
  ) {
    return {
      kind: 'not_found',
      message:
        'That conversation or message no longer exists in Slack. Try re-running the backfill.',
      retryable: false,
    };
  }

  if (
    code.includes('invalid_auth') ||
    code.includes('token_revoked') ||
    code.includes('account_inactive') ||
    code.includes('not_authed')
  ) {
    return {
      kind: 'auth',
      message:
        'The Slack token is no longer valid. Re-connect the workspace to continue.',
      retryable: false,
    };
  }

  if (
    code.includes('econnreset') ||
    code.includes('etimedout') ||
    code.includes('enotfound') ||
    code.includes('socket hang up') ||
    code.includes('fetch failed') ||
    code.includes('network')
  ) {
    return {
      kind: 'network',
      message: 'Could not reach Slack. Check your connection and try again.',
      retryable: true,
    };
  }

  return {
    kind: 'unknown',
    message:
      code === ''
        ? 'Slack rejected that without saying why.'
        : `Slack rejected that: ${code}.`,
    retryable: true,
  };
}
