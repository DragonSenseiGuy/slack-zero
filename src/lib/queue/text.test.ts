import { describe, expect, it } from 'vitest';

import {
  buildPreview,
  collapseWhitespace,
  renderSlackText,
  truncate,
} from '@/lib/queue/text';

/**
 * Fixtures are real Slack encodings, not invented ones — the whole risk here
 * is that a token form we never anticipated leaks into the UI as `<@U123>`.
 */

const users = new Map([
  ['U0BEHBXNGHK', 'dsg'],
  ['U0BK9FR4Y1M', 'Aditya'],
]);
const channels = new Map([
  ['C0BEJLKAB12', 'happenings'],
]);
const lookup = { users, channels };

describe('renderSlackText', () => {
  it('returns an empty string for null/undefined/empty input', () => {
    expect(renderSlackText(null)).toBe('');
    expect(renderSlackText(undefined)).toBe('');
    expect(renderSlackText('')).toBe('');
  });

  it('leaves plain text untouched', () => {
    expect(renderSlackText('hello there')).toBe('hello there');
  });

  it('resolves a bare user mention through the directory', () => {
    expect(renderSlackText('hey <@U0BK9FR4Y1M> ping', lookup)).toBe(
      'hey @Aditya ping',
    );
  });

  it('prefers the inline label Slack supplies over the directory', () => {
    expect(renderSlackText('<@U0BK9FR4Y1M|adi> hi', lookup)).toBe('@adi hi');
  });

  it('falls back to the raw id when the user is unknown', () => {
    expect(renderSlackText('<@UNOTKNOWN1>', lookup)).toBe('@UNOTKNOWN1');
  });

  it('handles Enterprise Grid ids starting with W', () => {
    expect(renderSlackText('<@W12345678>')).toBe('@W12345678');
  });

  it('renders channel references with and without a label', () => {
    expect(renderSlackText('see <#C0BEJLKAB12|happenings>', lookup)).toBe(
      'see #happenings',
    );
    expect(renderSlackText('see <#C0BEJLKAB12>', lookup)).toBe(
      'see #happenings',
    );
    expect(renderSlackText('see <#CUNKNOWN01>', lookup)).toBe('see #CUNKNOWN01');
  });

  it('renders broadcast specials', () => {
    expect(renderSlackText('<!here> please look')).toBe('@here please look');
    expect(renderSlackText('<!channel>')).toBe('@channel');
    expect(renderSlackText('<!everyone>')).toBe('@everyone');
  });

  it('renders a user group with its supplied label', () => {
    expect(renderSlackText('<!subteam^S012ABC|@design> ping')).toBe(
      '@design ping',
    );
  });

  it('renders a date token using its fallback text', () => {
    expect(
      renderSlackText('due <!date^1784938592^{date_short}|Jul 24, 2026>'),
    ).toBe('due Jul 24, 2026');
  });

  it('renders links as their label, or the bare url when unlabelled', () => {
    expect(renderSlackText('<https://example.com|the docs>')).toBe('the docs');
    expect(renderSlackText('<https://example.com>')).toBe(
      'https://example.com',
    );
  });

  it('strips the mailto: scheme from an unlabelled email link', () => {
    expect(renderSlackText('<mailto:a@b.com>')).toBe('a@b.com');
    expect(renderSlackText('<mailto:a@b.com|Ada>')).toBe('Ada');
  });

  it('decodes Slack entities', () => {
    expect(renderSlackText('a &amp; b &lt; c &gt; d')).toBe('a & b < c > d');
  });

  it('does not treat escaped angle brackets as a token', () => {
    // The user literally typed "<@U1>" — Slack escapes it, and decoding must
    // happen after token parsing or it would render as a mention.
    expect(renderSlackText('&lt;@U0BK9FR4Y1M&gt;', lookup)).toBe(
      '<@U0BK9FR4Y1M>',
    );
  });

  it('resolves several tokens of different kinds in one message', () => {
    expect(
      renderSlackText(
        '<@U0BEHBXNGHK> can you check <#C0BEJLKAB12|happenings>? see <https://x.dev|here>',
        lookup,
      ),
    ).toBe('@dsg can you check #happenings? see here');
  });

  it('leaves mrkdwn emphasis markers alone', () => {
    // Stripping these would lose what the author meant; the UI renders text.
    expect(renderSlackText('*bold* _italic_ `code`')).toBe(
      '*bold* _italic_ `code`',
    );
  });
});

describe('collapseWhitespace', () => {
  it('flattens newlines and runs of spaces, and trims', () => {
    expect(collapseWhitespace('  a\n\n  b\tc  ')).toBe('a b c');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(collapseWhitespace(' \n\t ')).toBe('');
  });
});

describe('truncate', () => {
  it('leaves short text untouched and adds no ellipsis', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('returns the input unchanged at exactly the limit', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });

  it('cuts at a word boundary when one is available late enough', () => {
    expect(truncate('the quick brown fox jumps', 20)).toBe('the quick brown fox…');
  });

  it('hard-cuts when the only word boundary is near the start', () => {
    // "a" then a very long word: honouring the boundary would drop almost
    // everything, so the character cut wins.
    expect(truncate('a bbbbbbbbbbbbbbbbbbbb', 10)).toBe('a bbbbbbbb…');
  });

  it('returns an empty string for a non-positive limit', () => {
    expect(truncate('anything', 0)).toBe('');
  });
});

describe('buildPreview', () => {
  it('renders, collapses, and truncates in one step', () => {
    expect(
      buildPreview('hey <@U0BK9FR4Y1M>\n\nare you around?', { lookup }),
    ).toBe('hey @Aditya are you around?');
  });

  it('uses the fallback for empty or whitespace-only text', () => {
    expect(buildPreview('', { fallback: '(file attachment)' })).toBe(
      '(file attachment)',
    );
    expect(buildPreview('   \n ', { fallback: '(no text)' })).toBe('(no text)');
    expect(buildPreview(null, { fallback: '(no text)' })).toBe('(no text)');
  });

  it('respects an explicit max length', () => {
    expect(buildPreview('aaaa bbbb cccc dddd', { maxLength: 9 })).toBe(
      'aaaa bbbb…',
    );
    expect(buildPreview('aaaa bbbb cccc dddd', { maxLength: 12 })).toBe(
      'aaaa bbbb…',
    );
  });

  it('is deterministic — the same input always yields the same preview', () => {
    const text = 'ping <@U0BEHBXNGHK> in <#C0BEJLKAB12>';
    expect(buildPreview(text, { lookup })).toBe(buildPreview(text, { lookup }));
  });
});
