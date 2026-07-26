import { describe, expect, it } from 'vitest';

import {
  isTypingTarget,
  resolveShortcut,
  SHORTCUT_HELP,
  type InboxMode,
  type KeyEventLike,
} from '@/lib/keyboard/shortcuts';

/**
 * The keyboard mapping is the product in Phase 2 — a wrong dispatch is not a
 * cosmetic bug, it is data loss (`e` marking the wrong thing done) or a dead
 * app. Hence exhaustive fixtures rather than a couple of happy paths.
 */

function key(k: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, ...modifiers };
}

function inMode(mode: InboxMode, isTyping = false) {
  return { mode, isTyping };
}

describe('resolveShortcut — list mode', () => {
  it('maps j/k to movement', () => {
    expect(resolveShortcut(key('j'), inMode('list'))).toEqual({
      type: 'move',
      delta: 1,
    });
    expect(resolveShortcut(key('k'), inMode('list'))).toEqual({
      type: 'move',
      delta: -1,
    });
  });

  it('mirrors j/k onto the arrow keys for discoverability', () => {
    expect(resolveShortcut(key('ArrowDown'), inMode('list'))).toEqual({
      type: 'move',
      delta: 1,
    });
    expect(resolveShortcut(key('ArrowUp'), inMode('list'))).toEqual({
      type: 'move',
      delta: -1,
    });
  });

  it('maps Enter to open', () => {
    expect(resolveShortcut(key('Enter'), inMode('list'))).toEqual({
      type: 'open',
    });
  });

  it('maps e to toggling done', () => {
    expect(resolveShortcut(key('e'), inMode('list'))).toEqual({
      type: 'toggleDone',
    });
  });

  it('maps Escape to back', () => {
    expect(resolveShortcut(key('Escape'), inMode('list'))).toEqual({
      type: 'back',
    });
  });

  it('maps g/G to first/last', () => {
    expect(resolveShortcut(key('g'), inMode('list'))).toEqual({
      type: 'moveTo',
      position: 'first',
    });
    expect(resolveShortcut(key('G'), inMode('list'))).toEqual({
      type: 'moveTo',
      position: 'last',
    });
  });

  it('maps u to toggling done visibility', () => {
    expect(resolveShortcut(key('u'), inMode('list'))).toEqual({
      type: 'toggleShowDone',
    });
  });

  it('ignores unbound keys', () => {
    for (const unbound of ['a', 'z', '1', 'F5', 'Tab']) {
      expect(resolveShortcut(key(unbound), inMode('list'))).toBeNull();
    }
  });

  it('binds the Phase 5 reply keys', () => {
    // Phase 2 left `r` and `d` deliberately unbound and asserted it, so that a
    // key could not mean two different things across phases. Phase 5 is the
    // phase that claims them, so the guard moves rather than disappears.
    expect(resolveShortcut(key('r'), inMode('list'))).toEqual({
      type: 'focusReply',
    });
    expect(resolveShortcut(key('d'), inMode('list'))).toEqual({
      type: 'draftReply',
    });
  });

  it('binds the Phase 6 snooze key', () => {
    // Reserved and asserted-unbound since Phase 2; Phase 6 is the phase that
    // claims it, so the guard moves rather than disappearing.
    expect(resolveShortcut(key('h'), inMode('list'))).toEqual({ type: 'snooze' });
  });

  it('stands snooze down while the user is typing', () => {
    expect(resolveShortcut(key('h'), { mode: 'list', isTyping: true })).toBeNull();
  });

  it('stands the reply keys down while the user is typing', () => {
    // Otherwise typing "read" into the compose box would fire `r` and `d`.
    expect(resolveShortcut(key('r'), { mode: 'list', isTyping: true })).toBeNull();
    expect(resolveShortcut(key('d'), { mode: 'list', isTyping: true })).toBeNull();
  });
});

describe('resolveShortcut — modifiers', () => {
  it('never steals a modified letter chord from the browser', () => {
    // ⌘E, Ctrl+J (downloads), Alt+K and friends must reach the browser.
    expect(resolveShortcut(key('e', { metaKey: true }), inMode('list'))).toBeNull();
    expect(resolveShortcut(key('j', { ctrlKey: true }), inMode('list'))).toBeNull();
    expect(resolveShortcut(key('k', { altKey: true }), inMode('list'))).toBeNull();
    expect(resolveShortcut(key('g', { metaKey: true }), inMode('list'))).toBeNull();
  });

  it('ignores a modified Enter', () => {
    expect(
      resolveShortcut(key('Enter', { metaKey: true }), inMode('list')),
    ).toBeNull();
  });

  it('opens the palette on ⌘K and on Ctrl+K', () => {
    expect(resolveShortcut(key('k', { metaKey: true }), inMode('list'))).toEqual(
      { type: 'openPalette' },
    );
    expect(resolveShortcut(key('k', { ctrlKey: true }), inMode('list'))).toEqual(
      { type: 'openPalette' },
    );
  });

  it('accepts an uppercase K in the chord (Shift held)', () => {
    expect(
      resolveShortcut(key('K', { metaKey: true, shiftKey: true }), inMode('list')),
    ).toEqual({ type: 'openPalette' });
  });

  it('does not treat Alt+⌘K as the palette chord', () => {
    expect(
      resolveShortcut(key('k', { metaKey: true, altKey: true }), inMode('list')),
    ).toBeNull();
  });

  it('toggles the palette shut when the chord is pressed again', () => {
    expect(
      resolveShortcut(key('k', { metaKey: true }), inMode('palette')),
    ).toEqual({ type: 'closePalette' });
  });

  it('opens the palette even while typing in a text field', () => {
    // Otherwise ⌘K would be dead in any input, which is where users reach for it.
    expect(
      resolveShortcut(key('k', { metaKey: true }), inMode('list', true)),
    ).toEqual({ type: 'openPalette' });
  });
});

describe('resolveShortcut — reading mode', () => {
  it('keeps j/k moving through the queue so a run of reading is uninterrupted', () => {
    expect(resolveShortcut(key('j'), inMode('reading'))).toEqual({
      type: 'move',
      delta: 1,
    });
  });

  it('keeps e available so you can read then archive without leaving', () => {
    expect(resolveShortcut(key('e'), inMode('reading'))).toEqual({
      type: 'toggleDone',
    });
  });

  it('maps Escape to back', () => {
    expect(resolveShortcut(key('Escape'), inMode('reading'))).toEqual({
      type: 'back',
    });
  });
});

describe('resolveShortcut — palette mode', () => {
  it('moves the highlight with the arrow keys', () => {
    expect(resolveShortcut(key('ArrowDown'), inMode('palette'))).toEqual({
      type: 'move',
      delta: 1,
    });
    expect(resolveShortcut(key('ArrowUp'), inMode('palette'))).toEqual({
      type: 'move',
      delta: -1,
    });
  });

  it('picks the highlighted entry on Enter', () => {
    expect(resolveShortcut(key('Enter'), inMode('palette'))).toEqual({
      type: 'palettePick',
    });
  });

  it('closes on Escape', () => {
    expect(resolveShortcut(key('Escape'), inMode('palette'))).toEqual({
      type: 'closePalette',
    });
  });

  it('lets ordinary letters through to the search input', () => {
    // Critical: typing "jek" into the palette must not navigate the queue and
    // mark something done behind the dialog.
    for (const letter of ['j', 'k', 'e', 'g', 'u']) {
      expect(resolveShortcut(key(letter), inMode('palette'))).toBeNull();
    }
  });
});

describe('resolveShortcut — typing guard', () => {
  it('suppresses every letter shortcut while typing', () => {
    for (const letter of ['j', 'k', 'e', 'g', 'G', 'u']) {
      expect(resolveShortcut(key(letter), inMode('list', true))).toBeNull();
    }
  });

  it('suppresses Enter and the arrows while typing', () => {
    expect(resolveShortcut(key('Enter'), inMode('list', true))).toBeNull();
    expect(resolveShortcut(key('ArrowDown'), inMode('list', true))).toBeNull();
  });

  it('still honours Escape while typing, as a way out', () => {
    expect(resolveShortcut(key('Escape'), inMode('list', true))).toEqual({
      type: 'back',
    });
  });
});

describe('isTypingTarget', () => {
  it('detects inputs, textareas and selects', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(
      true,
    );
    expect(
      isTypingTarget({ tagName: 'textarea' } as unknown as EventTarget),
    ).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(
      true,
    );
  });

  it('detects contenteditable elements', () => {
    expect(
      isTypingTarget({
        tagName: 'DIV',
        isContentEditable: true,
      } as unknown as EventTarget),
    ).toBe(true);
  });

  it('returns false for ordinary elements and for null', () => {
    expect(isTypingTarget({ tagName: 'BODY' } as unknown as EventTarget)).toBe(
      false,
    );
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(
      false,
    );
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('SHORTCUT_HELP', () => {
  it('documents every shortcut plan.md names for this phase', () => {
    const documented = SHORTCUT_HELP.map((entry) => entry.keys).join(' ');
    for (const expected of ['j / k', 'Enter', 'e', 'Esc', '⌘K']) {
      expect(documented).toContain(expected);
    }
  });
});
