import { describe, expect, it } from 'vitest';

import {
  filterPaletteEntries,
  scoreEntry,
  type PaletteEntry,
} from '@/lib/palette/search';

const entries: PaletteEntry[] = [
  {
    id: 'conversation:C1',
    kind: 'conversation',
    label: '#general',
    keywords: ['C1'],
    weight: 3,
  },
  {
    id: 'conversation:C2',
    kind: 'conversation',
    label: '#general-random',
    keywords: ['C2'],
    weight: 0,
  },
  {
    id: 'conversation:C3',
    kind: 'conversation',
    label: '#happenings',
    keywords: ['C3'],
    weight: 0,
  },
  {
    id: 'person:U1',
    kind: 'person',
    label: 'Ada Lovelace',
    keywords: ['U1', 'ada'],
    weight: 1,
  },
  {
    id: 'person:U2',
    kind: 'person',
    label: 'Grace Hopper',
    keywords: ['U2', 'grace'],
    weight: 0,
  },
];

describe('scoreEntry', () => {
  const general = entries[0];

  it('scores every entry equally for an empty query', () => {
    expect(scoreEntry(general, '')).toBe(1);
    expect(scoreEntry(entries[3], '')).toBe(1);
  });

  it('scores an exact label match highest', () => {
    expect(scoreEntry(general, '#general')).toBe(1000);
  });

  it('ignores the leading sigil, so "general" is still exact', () => {
    expect(scoreEntry(general, 'general')).toBe(1000);
  });

  it('scores a prefix above a mid-string match', () => {
    expect(scoreEntry(general, 'gen')).toBeGreaterThan(
      scoreEntry(entries[2], 'pen'),
    );
  });

  it('scores an earlier substring above a later one', () => {
    const early: PaletteEntry = { id: 'a', kind: 'person', label: 'xabc' };
    const late: PaletteEntry = { id: 'b', kind: 'person', label: 'xxxxxabc' };
    expect(scoreEntry(early, 'abc')).toBeGreaterThan(scoreEntry(late, 'abc'));
  });

  it('scores a keyword-only match lowest but non-zero', () => {
    const score = scoreEntry(entries[3], 'u1');
    expect(score).toBe(100);
  });

  it('scores a non-match at zero', () => {
    expect(scoreEntry(general, 'zzzz')).toBe(0);
  });

  it('is case-insensitive on the label', () => {
    expect(scoreEntry(entries[3], 'ada')).toBe(500);
  });
});

describe('filterPaletteEntries', () => {
  it('returns everything for an empty query, ranked by weight', () => {
    const results = filterPaletteEntries(entries, '');
    expect(results).toHaveLength(entries.length);
    expect(results[0].label).toBe('#general');
    expect(results[1].label).toBe('Ada Lovelace');
  });

  it('ignores surrounding whitespace in the query', () => {
    expect(filterPaletteEntries(entries, '  general  ')[0].label).toBe(
      '#general',
    );
  });

  it('drops non-matching entries entirely', () => {
    const results = filterPaletteEntries(entries, 'happen');
    expect(results.map((entry) => entry.label)).toEqual(['#happenings']);
  });

  it('ranks the exact match above the longer prefix match', () => {
    const results = filterPaletteEntries(entries, 'general');
    expect(results.map((entry) => entry.label)).toEqual([
      '#general',
      '#general-random',
    ]);
  });

  it('finds a person by Slack id via keywords', () => {
    expect(filterPaletteEntries(entries, 'U2').map((e) => e.label)).toEqual([
      'Grace Hopper',
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterPaletteEntries(entries, 'zzzzz')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(filterPaletteEntries(entries, '', 2)).toHaveLength(2);
  });

  it('is deterministic — identical relevance still yields a stable order', () => {
    const tied: PaletteEntry[] = [
      { id: 'z', kind: 'person', label: 'Same' },
      { id: 'a', kind: 'person', label: 'Same' },
    ];
    const first = filterPaletteEntries(tied, 'same').map((e) => e.id);
    const second = filterPaletteEntries([...tied].reverse(), 'same').map(
      (e) => e.id,
    );
    expect(first).toEqual(['a', 'z']);
    expect(second).toEqual(first);
  });

  it('handles an empty entry list', () => {
    expect(filterPaletteEntries([], 'anything')).toEqual([]);
  });
});
