export type LabelLookup = {
  users?: ReadonlyMap<string, string>;
  channels?: ReadonlyMap<string, string>;
};

function decodeSlackEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const TOKEN_PATTERN = /<([^<>]*)>/g;

function renderToken(inner: string, lookup: LabelLookup): string {
  if (inner.startsWith('@')) {
    const [idPart, label] = splitOnFirstPipe(inner.slice(1));
    if (label) return `@${label}`;
    const resolved = lookup.users?.get(idPart);
    return `@${resolved ?? idPart}`;
  }

  if (inner.startsWith('#')) {
    const [idPart, label] = splitOnFirstPipe(inner.slice(1));
    if (label) return `#${label}`;
    const resolved = lookup.channels?.get(idPart);
    return `#${resolved ?? idPart}`;
  }

  if (inner.startsWith('!')) {
    const [command, label] = splitOnFirstPipe(inner.slice(1));
    if (label) return label;
    const bare = command.split('^')[0];
    return `@${bare}`;
  }

  const [target, label] = splitOnFirstPipe(inner);
  if (label) return label;
  return target.startsWith('mailto:') ? target.slice('mailto:'.length) : target;
}

function splitOnFirstPipe(value: string): [string, string | null] {
  const index = value.indexOf('|');
  if (index === -1) return [value, null];
  return [value.slice(0, index), value.slice(index + 1)];
}

export function renderSlackText(
  text: string | null | undefined,
  lookup: LabelLookup = {},
): string {
  if (!text) return '';

  const withTokensResolved = text.replace(TOKEN_PATTERN, (_match, inner) =>
    renderToken(String(inner), lookup),
  );

  return decodeSlackEntities(withTokensResolved);
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;

  const hardCut = text.slice(0, maxLength);
  const lastSpace = hardCut.lastIndexOf(' ');
  const cut = lastSpace > maxLength * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;

  return `${cut.trimEnd()}…`;
}

export const DEFAULT_PREVIEW_LENGTH = 140;

export function buildPreview(
  text: string | null | undefined,
  options: {
    lookup?: LabelLookup;
    maxLength?: number;
    fallback?: string;
  } = {},
): string {
  const {
    lookup = {},
    maxLength = DEFAULT_PREVIEW_LENGTH,
    fallback = '',
  } = options;

  const plain = collapseWhitespace(renderSlackText(text, lookup));
  if (!plain) return fallback;

  return truncate(plain, maxLength);
}
