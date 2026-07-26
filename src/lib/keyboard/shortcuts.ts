/**
 * Keyboard dispatch for the inbox.
 *
 * The mapping is a pure function of (key event, current mode) so it can be
 * unit tested without a browser or React — the component only has to execute
 * the returned action. Getting this wrong is the fastest way to make a
 * keyboard-first app feel broken, so it gets fixture tests rather than
 * "I clicked around and it seemed fine".
 *
 * Phase 2 shortcuts (plan.md): `j`/`k` move, `Enter` open, `e` mark done,
 * `Esc` back, `⌘K` command palette. Phase 3 adds `s` to switch sort mode.
 * Reply (`r`) is Phase 5 and snooze (`h`) is Phase 6 — deliberately absent.
 */

/** Which surface currently owns the keyboard. */
export type InboxMode = 'list' | 'reading' | 'palette';

export type InboxAction =
  /** Move the queue selection. */
  | { type: 'move'; delta: number }
  | { type: 'moveTo'; position: 'first' | 'last' }
  /** Open the selected item in the reading pane and focus it. */
  | { type: 'open' }
  /** Toggle SlackZero's own done state on the selected item. */
  | { type: 'toggleDone' }
  /** Leave reading mode / close the palette / clear the active scope. */
  | { type: 'back' }
  | { type: 'openPalette' }
  | { type: 'closePalette' }
  /** Confirm the highlighted palette entry. */
  | { type: 'palettePick' }
  | { type: 'toggleShowDone' }
  /** Switch between sort-by-urgency and sort-by-recency (Phase 3). */
  | { type: 'cycleSort' };

/**
 * The parts of a `KeyboardEvent` this module reads. Declared structurally so
 * tests can pass plain objects and so nothing here depends on the DOM.
 */
export type KeyEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export type ShortcutContext = {
  mode: InboxMode;
  /** True when focus is in a text field; almost all shortcuts stand down. */
  isTyping?: boolean;
};

function hasModifier(event: KeyEventLike): boolean {
  return Boolean(event.metaKey || event.ctrlKey || event.altKey);
}

/** `⌘K` on macOS, `Ctrl+K` elsewhere. Both are accepted on both platforms. */
function isPaletteChord(event: KeyEventLike): boolean {
  return (
    (event.metaKey === true || event.ctrlKey === true) &&
    event.altKey !== true &&
    event.key.toLowerCase() === 'k'
  );
}

/**
 * Map a key event to an inbox action, or null to let the browser have it.
 *
 * Precedence is deliberate:
 *  1. `⌘K` works from anywhere, including inside the palette's own input —
 *     otherwise the chord that opens the palette would be dead once it is open.
 *  2. While typing, only `Escape`, `Enter` (in the palette), and the arrow keys
 *     do anything. A user typing "jkee" into a search box must not have their
 *     queue navigate and mark three things done.
 *  3. `Escape` unwinds one layer at a time: palette → reading → scope.
 */
export function resolveShortcut(
  event: KeyEventLike,
  context: ShortcutContext,
): InboxAction | null {
  const { mode, isTyping = false } = context;

  if (isPaletteChord(event)) {
    return mode === 'palette' ? { type: 'closePalette' } : { type: 'openPalette' };
  }

  if (mode === 'palette') {
    switch (event.key) {
      case 'Escape':
        return { type: 'closePalette' };
      case 'ArrowDown':
        return { type: 'move', delta: 1 };
      case 'ArrowUp':
        return { type: 'move', delta: -1 };
      case 'Enter':
        return hasModifier(event) ? null : { type: 'palettePick' };
      default:
        return null;
    }
  }

  if (isTyping) {
    return event.key === 'Escape' ? { type: 'back' } : null;
  }

  // Arrow keys mirror j/k so the app is usable before the shortcuts are known.
  switch (event.key) {
    case 'ArrowDown':
      return { type: 'move', delta: 1 };
    case 'ArrowUp':
      return { type: 'move', delta: -1 };
    case 'Escape':
      return { type: 'back' };
    case 'Enter':
      return hasModifier(event) ? null : { type: 'open' };
    default:
      break;
  }

  // Everything below is an unmodified letter. `⌘E` is "search in page" in some
  // browsers and `Ctrl+J` opens downloads — never steal a modified chord.
  if (hasModifier(event)) return null;

  switch (event.key) {
    case 'j':
      return { type: 'move', delta: 1 };
    case 'k':
      return { type: 'move', delta: -1 };
    case 'e':
      return { type: 'toggleDone' };
    case 'g':
      return { type: 'moveTo', position: 'first' };
    case 'G':
      return { type: 'moveTo', position: 'last' };
    case 'u':
      return { type: 'toggleShowDone' };
    case 's':
      return { type: 'cycleSort' };
    default:
      return null;
  }
}

/**
 * True when the event target is somewhere text is being entered, so shortcuts
 * should stand down. Kept separate from `resolveShortcut` because it is the
 * only DOM-aware part, and the component passes the answer in.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  // Duck-typed rather than `instanceof HTMLElement`: this also has to be
  // callable in a non-DOM context (tests, SSR) without exploding.
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
  };

  if (element.isContentEditable === true) return true;

  const tag = element.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The cheat sheet rendered in the UI. Single source of truth for both. */
export const SHORTCUT_HELP: ReadonlyArray<{ keys: string; description: string }> =
  [
    { keys: 'j / k', description: 'Next / previous message' },
    { keys: 'Enter', description: 'Open in the reading pane' },
    { keys: 'e', description: 'Mark done (or undo)' },
    { keys: 'Esc', description: 'Back to the list / clear the filter' },
    { keys: '⌘K', description: 'Jump to a channel or person' },
    { keys: 's', description: 'Sort by urgency / recency' },
    { keys: 'u', description: 'Show or hide done items' },
    { keys: 'g / G', description: 'First / last message' },
  ];
