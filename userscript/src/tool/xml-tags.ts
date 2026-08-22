/**
 * Userscript port of core/tool/xml-tags.ts.
 *
 * Linear-time XML tag scanning. The original regex approach suffered
 * catastrophic backtracking on adversarial model output, so the extension
 * replaced it with this explicit scanner; the port keeps that property since
 * it runs on every streamed chunk.
 */

const PARTIAL_TAG_WHITESPACE_LIMIT = 8;

export interface XmlToolTagMatch {
  index: number;
  endIndex: number;
  name: string;
  raw: string;
  closing: boolean;
}

export function findFirstXmlToolTag(
  text: string,
  toolNames: ReadonlySet<string>,
  options: { closing: boolean; fromIndex?: number },
): XmlToolTagMatch | null {
  if (!text || toolNames.size === 0) return null;

  let searchFrom = Math.max(0, options.fromIndex ?? 0);
  // Carry the known '>' forward so a long run of '<' cannot force a quadratic
  // re-scan of the same tag region.
  let knownTagEnd = -1;
  while (searchFrom < text.length) {
    const index = text.indexOf('<', searchFrom);
    if (index === -1) return null;

    const tagEnd = knownTagEnd > index ? knownTagEnd : text.indexOf('>', index + 1);
    if (tagEnd === -1) return null;

    const parsed = parseCompleteXmlToolTag(text, index, tagEnd, toolNames);
    if (parsed && parsed.closing === options.closing) return parsed;

    const nextLt = text.indexOf('<', index + 1);
    if (nextLt !== -1 && nextLt < tagEnd) {
      knownTagEnd = tagEnd;
      searchFrom = nextLt;
    } else {
      knownTagEnd = -1;
      searchFrom = tagEnd + 1;
    }
  }

  return null;
}

/**
 * Length of a trailing fragment that could still grow into a tool tag. The
 * streaming filter holds this tail back so a tag split across SSE chunks is
 * never emitted to the page half-open.
 */
export function getPartialXmlToolTagTailLength(
  text: string,
  toolNames: ReadonlySet<string>,
  options: { closing: boolean },
): number {
  if (!text || toolNames.size === 0) return 0;

  const names = Array.from(toolNames);
  const maxNameLength = Math.max(0, ...names.map((name) => name.length));
  const limit = Math.min(text.length, 2 + maxNameLength + PARTIAL_TAG_WHITESPACE_LIMIT * 2);

  for (let length = limit; length > 0; length -= 1) {
    if (isPartialXmlToolTag(text.slice(-length), names, options.closing)) return length;
  }
  return 0;
}

function parseCompleteXmlToolTag(
  text: string,
  index: number,
  tagEnd: number,
  toolNames: ReadonlySet<string>,
): XmlToolTagMatch | null {
  let cursor = index + 1;
  cursor = skipWhitespace(text, cursor, tagEnd);

  let closing = false;
  if (text[cursor] === '/') {
    closing = true;
    cursor += 1;
    cursor = skipWhitespace(text, cursor, tagEnd);
  }

  if (!isToolNameStart(text[cursor])) return null;
  const nameStart = cursor;
  cursor += 1;
  while (cursor < tagEnd && isToolNameChar(text[cursor])) {
    cursor += 1;
  }

  const name = text.slice(nameStart, cursor);
  if (!toolNames.has(name)) return null;

  cursor = skipWhitespace(text, cursor, tagEnd);
  if (cursor !== tagEnd) return null;

  return {
    index,
    endIndex: tagEnd + 1,
    name,
    raw: text.slice(index, tagEnd + 1),
    closing,
  };
}

function isPartialXmlToolTag(
  value: string,
  toolNames: readonly string[],
  closing: boolean,
): boolean {
  if (!value.startsWith('<')) return false;
  let cursor = 1;

  const beforeSlash = skipLimitedWhitespace(value, cursor);
  if (beforeSlash === value.length) return true;
  cursor = beforeSlash;

  if (value[cursor] === '/') {
    if (!closing) return false;
    cursor += 1;
    const beforeName = skipLimitedWhitespace(value, cursor);
    if (beforeName === value.length) return true;
    cursor = beforeName;
  } else if (closing) {
    return false;
  }

  if (!isToolNameStart(value[cursor])) return false;
  const nameStart = cursor;
  cursor += 1;
  while (cursor < value.length && isToolNameChar(value[cursor])) {
    cursor += 1;
  }

  const typedName = value.slice(nameStart, cursor);
  if (!toolNames.some((name) => name.startsWith(typedName))) return false;

  const afterName = skipLimitedWhitespace(value, cursor);
  return afterName === value.length;
}

function skipWhitespace(text: string, cursor: number, end: number): number {
  while (cursor < end && isWhitespace(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function skipLimitedWhitespace(text: string, cursor: number): number {
  let count = 0;
  while (
    cursor < text.length &&
    count < PARTIAL_TAG_WHITESPACE_LIMIT &&
    isWhitespace(text[cursor])
  ) {
    cursor += 1;
    count += 1;
  }
  return cursor;
}

function isWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t' || value === '\f';
}

function isToolNameStart(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z_]/.test(value));
}

function isToolNameChar(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z0-9_.:-]/.test(value));
}

export function getToolOpenTag(name: string): string {
  return `<${name}>`;
}

export function getToolCloseTag(name: string): string {
  return `</${name}>`;
}
