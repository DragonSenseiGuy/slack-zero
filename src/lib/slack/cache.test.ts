import { describe, expect, it } from 'vitest';
import { BoundedTtlCache } from './cache';

describe('BoundedTtlCache', () => {
  it('expires entries with an injected clock', () => {
    let now = 0;
    const cache = new BoundedTtlCache<string, string>(2, 10, () => now);
    cache.set('a', 'private');
    now = 10;
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the least recently used entry at its bound', () => {
    const cache = new BoundedTtlCache<string, number>(2, 10, () => 0);
    cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(2);
  });
});
