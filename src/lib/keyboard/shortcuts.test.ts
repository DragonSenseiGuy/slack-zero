import { describe, expect, it } from 'vitest';

import {
  isTypingTarget,
  resolveShortcut,
  SHORTCUT_HELP,
  type InboxMode,
  type KeyEventLike,
} from '@/lib/keyboard/shortcuts';

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
    expect(resolveShortcut(key('r'), inMode('list'))).toEqual({
      type: 'focusReply',
    });
    expect(resolveShortcut(key('d'), inMode('list'))).toEqual({
      type: 'draftReply',
    });
  });

  it('binds ? to the cheat sheet', () => {
    expect(resolveShortcut(key('?'), inMode('list'))).toEqual({
      type: 'toggleHelp',
    });
    expect(resolveShortcut(key('?'), { mode: 'list', isTyping: true })).toBeNull();
  });

  it('documents every binding it resolves', () => {
    const documented = SHORTCUT_HELP.map((entry) => entry.keys).join(' ');
    for (const k of ['j', 'k', 'e', 'u', 's', 'r', 'd', 'h', '?']) {
      expect(documented, `${k} is bound but undocumented`).toContain(k);
    }
  });

  it('binds the Phase 6 snooze key', () => {
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

  it('leaves ⌘K to the browser now that the jump-to palette is gone', () => {
    expect(
      resolveShortcut(key('k', { metaKey: true }), inMode('list')),
    ).toBeNull();
    expect(
      resolveShortcut(key('k', { ctrlKey: true }), inMode('list')),
    ).toBeNull();
    expect(
      resolveShortcut(key('k', { metaKey: true }), inMode('list', true)),
    ).toBeNull();
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

describe('SHORTCUT_HELP', () => {
  it('does not advertise the removed palette chord', () => {
    expect(SHORTCUT_HELP.some((entry) => entry.keys.includes('K'))).toBe(false);
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
    for (const expected of ['j / k', 'Enter', 'e', 'Esc', 's', 'u', '?']) {
      expect(documented).toContain(expected);
    }
  });
});
