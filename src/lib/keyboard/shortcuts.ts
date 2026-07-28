export type InboxMode = 'list' | 'reading';

export type InboxAction =
  | { type: 'move'; delta: number }
  | { type: 'moveTo'; position: 'first' | 'last' }
  | { type: 'open' }
  | { type: 'toggleDone' }
  | { type: 'back' }
  | { type: 'toggleShowDone' }
  | { type: 'cycleSort' }
  | { type: 'draftReply' }
  | { type: 'focusReply' }
  | { type: 'snooze' }
  | { type: 'toggleHelp' };

export type KeyEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export type ShortcutContext = {
  mode: InboxMode;
  isTyping?: boolean;
};

function hasModifier(event: KeyEventLike): boolean {
  return Boolean(event.metaKey || event.ctrlKey || event.altKey);
}

export function resolveShortcut(
  event: KeyEventLike,
  context: ShortcutContext,
): InboxAction | null {
  const { isTyping = false } = context;

  if (isTyping) {
    return event.key === 'Escape' ? { type: 'back' } : null;
  }

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
    case 'd':
      return { type: 'draftReply' };
    case 'r':
      return { type: 'focusReply' };
    case 'h':
      return { type: 'snooze' };
    case '?':
      return { type: 'toggleHelp' };
    default:
      return null;
  }
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
  };

  if (element.isContentEditable === true) return true;

  const tag = element.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export const SHORTCUT_HELP: ReadonlyArray<{ keys: string; description: string }> =
  [
    { keys: 'j / k', description: 'Next / previous message' },
    { keys: 'Enter', description: 'Open in the reading pane' },
    { keys: 'e', description: 'Mark as complete (or undo)' },
    { keys: 'Esc', description: 'Back to the list / clear the filter' },
    { keys: 's', description: 'Cycle the sort order' },
    { keys: 'u', description: 'Show or hide completed items' },
    { keys: 'g / G', description: 'First / last message' },
    { keys: 'r', description: 'Reply' },
    { keys: 'd', description: 'Suggest replies' },
    { keys: 'h', description: 'Snooze' },
    { keys: '?', description: 'This list' },
  ];
