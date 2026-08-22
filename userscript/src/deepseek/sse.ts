/**
 * Userscript port of core/deepseek/stream-codec.ts.
 *
 * DeepSeek streams JSON-patch style SSE frames. Text arrives through several
 * shapes that all have to be recognised:
 *
 *   {"v":"text"}                                    bare append to current fragment
 *   {"p":"response/fragments/-1/content","v":"..."} explicit path append
 *   {"p":"response/fragments","o":"APPEND","v":[…]} fragment creation w/ content
 *   {"o":"BATCH","v":[…]}                           batch of the above
 *
 * The filter needs both a reader (extract text) and a writer (rewrite text in
 * place) for every shape, which is why the set/get helpers are symmetrical.
 */

import type { SSEEvent } from '../types';

export interface DeepSeekSseFrame {
  readonly block: string;
  readonly separator: string;
  readonly event: SSEEvent | null;
  readonly parsed: unknown | null;
}

export interface DeepSeekSseFrameDecoder {
  push(text: string): DeepSeekSseFrame[];
  finish(): DeepSeekSseFrame[];
}

export function createDeepSeekSseFrameDecoder(): DeepSeekSseFrameDecoder {
  let buffer = '';
  let scanFrom = 0;

  const drain = (): DeepSeekSseFrame[] => {
    const frames: DeepSeekSseFrame[] = [];
    const boundaryPattern = /\r?\n\r?\n/g;
    boundaryPattern.lastIndex = scanFrom;
    let offset = 0;
    let match: RegExpExecArray | null;

    while ((match = boundaryPattern.exec(buffer)) !== null) {
      const separator = match[0];
      frames.push(createFrame(buffer.slice(offset, match.index), separator));
      offset = match.index + separator.length;
    }

    buffer = buffer.slice(offset);
    // Keep up to 3 chars so a `\r\n\r\n` split across chunks is still found.
    scanFrom = Math.max(0, buffer.length - 3);
    return frames;
  };

  return {
    push(text) {
      buffer += text;
      return drain();
    },
    finish() {
      const frames = drain();
      if (buffer.length > 0) {
        frames.push(createFrame(buffer, ''));
        buffer = '';
        scanFrom = 0;
      }
      return frames;
    },
  };
}

function createFrame(block: string, separator: string): DeepSeekSseFrame {
  const event = parseSSEBlock(block);
  let parsedResolved = false;
  let parsed: unknown | null = null;
  return {
    block,
    separator,
    event,
    // Lazily parsed: most frames are forwarded untouched.
    get parsed() {
      if (!parsedResolved) {
        parsed = event ? parseSSEData(event.data) : null;
        parsedResolved = true;
      }
      return parsed;
    },
  };
}

function parseSSEBlock(block: string): SSEEvent | null {
  if (!block.trim()) return null;
  let id: string | undefined;
  let type = 'message';
  const dataLines: string[] = [];

  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith(':')) continue;
    const colonIndex = rawLine.indexOf(':');
    const field = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : rawLine.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'id') id = value;
    else if (field === 'event') type = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { ...(id !== undefined ? { id } : {}), type, data: dataLines.join('\n') };
}

function parseSSEData(data: string): unknown | null {
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Rewrites a frame's `data:` payload while preserving its other SSE fields. */
export function replaceSseFrameData(frame: DeepSeekSseFrame, data: string): string {
  const lines = frame.block.split(/\r?\n/);
  const result: string[] = [];
  let dataWritten = false;
  for (const line of lines) {
    if (line.startsWith('data:')) {
      if (!dataWritten) {
        result.push(`data: ${data}`);
        dataWritten = true;
      }
      continue;
    }
    result.push(line);
  }
  if (!dataWritten) result.push(`data: ${data}`);
  return result.join('\n');
}

const RESPONSE_TEXT_PATHS = new Set([
  'response/content',
  'response/fragments/-1/content',
  'response/fragments/-1/text',
]);

function isResponseTextPatchPath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  if (RESPONSE_TEXT_PATHS.has(path)) return true;
  return /^response\/fragments\/-?\d+\/(content|text)$/.test(path);
}

export function isBatchPatch(parsed: any): boolean {
  return parsed?.o === 'BATCH' && Array.isArray(parsed.v);
}

export function isFragmentCreationPatch(parsed: any): boolean {
  return (
    typeof parsed?.p === 'string' &&
    parsed.p.endsWith('/fragments') &&
    parsed.o === 'APPEND' &&
    Array.isArray(parsed.v)
  );
}

export function isResponsePatch(parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  if (!parsed.p) return true;
  return (
    typeof parsed.p === 'string' &&
    (parsed.p === 'response' || parsed.p.startsWith('response/'))
  );
}

/** Extracts the assistant text delta carried by a parsed frame, if any. */
export function extractResponseTextFromParsed(parsed: any): string | null {
  if (!parsed || typeof parsed !== 'object') return null;

  if (isBatchPatch(parsed)) {
    const text = parsed.v
      .map((item: unknown) => extractResponseTextFromParsed(item))
      .filter((part: string | null): part is string => part !== null)
      .join('');
    return text.length > 0 ? text : null;
  }
  if (!parsed.p && typeof parsed.v === 'string') return parsed.v;
  if (isResponseTextPatchPath(parsed.p) && parsed.o === 'APPEND' && typeof parsed.v === 'string') {
    return parsed.v;
  }
  if (isResponseTextPatchPath(parsed.p) && typeof parsed.v === 'string' && !parsed.o) {
    return parsed.v;
  }
  if (isFragmentCreationPatch(parsed)) {
    const text = parsed.v
      .map((fragment: any) => extractFragmentText(fragment))
      .filter((part: string | null): part is string => part !== null)
      .join('');
    return text.length > 0 ? text : null;
  }
  return null;
}

function extractFragmentText(fragment: any): string | null {
  if (!fragment || typeof fragment !== 'object') return null;
  if (typeof fragment.content === 'string') return fragment.content;
  if (typeof fragment.text === 'string') return fragment.text;
  return null;
}

/**
 * Reads any direct text payload, including non-response paths. Used by the
 * prompt sanitizer, which must also clean the echoed request message.
 */
export function getAnyDirectPatchText(parsed: any): string | null {
  if (!parsed?.p && typeof parsed?.v === 'string') return parsed.v;
  if (parsed?.p && parsed.o === 'APPEND' && typeof parsed.v === 'string') return parsed.v;
  if (typeof parsed?.p === 'string' && typeof parsed.v === 'string' && !parsed.o) {
    const lastSegment = parsed.p.split('/').pop();
    if (
      lastSegment === 'content' ||
      lastSegment === 'text' ||
      lastSegment === 'markdown' ||
      lastSegment === 'delta'
    ) {
      return parsed.v;
    }
  }
  if (isFragmentCreationPatch(parsed)) {
    const parts: string[] = [];
    for (const fragment of parsed.v) {
      const text = extractFragmentText(fragment);
      if (text !== null) parts.push(text);
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

export function setAnyDirectPatchText(parsed: any, value: string): void {
  if (!parsed?.p && typeof parsed?.v === 'string') {
    parsed.v = value;
    return;
  }
  if (parsed?.p && parsed.o === 'APPEND' && typeof parsed.v === 'string') {
    parsed.v = value;
    return;
  }
  if (typeof parsed?.p === 'string' && typeof parsed.v === 'string' && !parsed.o) {
    parsed.v = value;
    return;
  }
  if (isFragmentCreationPatch(parsed)) {
    distributeFragmentText(parsed.v, value);
  }
}

/**
 * Writes `value` back across a fragment array, preserving each fragment's
 * original length except the last, which absorbs the remainder.
 */
function distributeFragmentText(fragments: any[], value: string): void {
  let remaining = value;
  for (let index = 0; index < fragments.length; index++) {
    const fragment = fragments[index];
    if (!fragment) continue;
    const key =
      typeof fragment.content === 'string'
        ? 'content'
        : typeof fragment.text === 'string'
          ? 'text'
          : null;
    if (!key) continue;
    if (index === fragments.length - 1) {
      fragment[key] = remaining;
    } else {
      const portion = remaining.slice(0, (fragment[key] as string).length);
      remaining = remaining.slice((fragment[key] as string).length);
      fragment[key] = portion;
    }
  }
}

/** Clones a frame payload keeping only the text from `offset` onward. */
export function cloneParsedWithTextSuffix(parsed: any, offset: number): any | null {
  const text = extractResponseTextFromParsed(parsed);
  if (text === null) return null;
  if (offset <= 0) return parsed;
  if (offset >= text.length) return null;
  const cloned = JSON.parse(JSON.stringify(parsed));
  setResponseText(cloned, text.slice(offset));
  return cloned;
}

/** Clones a frame payload keeping only the first `length` chars of its text. */
export function cloneParsedWithTextPrefix(parsed: any, length: number): any | null {
  const text = extractResponseTextFromParsed(parsed);
  if (text === null) return null;
  const cloned = JSON.parse(JSON.stringify(parsed));
  setResponseText(cloned, text.slice(0, Math.max(0, length)));
  return cloned;
}

function setResponseText(parsed: any, value: string): void {
  if (isBatchPatch(parsed)) {
    // A batch's text is the concatenation of its items; assign the whole value
    // to the first text-bearing item and clear the rest.
    let assigned = false;
    for (const item of parsed.v) {
      if (extractResponseTextFromParsed(item) === null) continue;
      setResponseText(item, assigned ? '' : value);
      assigned = true;
    }
    return;
  }
  setAnyDirectPatchText(parsed, value);
}

export interface DeepSeekStreamSummary {
  assistantText: string;
  responseMessageId: number | null;
  finished: boolean;
}

export function createDeepSeekStreamSummary(): DeepSeekStreamSummary {
  return { assistantText: '', responseMessageId: null, finished: false };
}

/** Accumulates message ids and finish state from a batch of frames. */
export function consumeSseFrames(
  frames: readonly DeepSeekSseFrame[],
  summary: DeepSeekStreamSummary,
  onParsed?: (parsed: unknown, event: SSEEvent) => void,
): void {
  for (const frame of frames) {
    if (!frame.event || !frame.parsed) continue;
    const parsed = frame.parsed as any;
    if (isBatchPatch(parsed)) {
      for (const item of parsed.v) consumeParsed(item, summary);
    } else {
      consumeParsed(parsed, summary);
    }
    onParsed?.(frame.parsed, frame.event);
  }
}

function consumeParsed(parsed: any, summary: DeepSeekStreamSummary): void {
  if (!parsed || typeof parsed !== 'object') return;
  if (parsed.p === 'response/message_id' && typeof parsed.v === 'number') {
    summary.responseMessageId = parsed.v;
  }
  if (
    typeof parsed.v === 'object' &&
    parsed.v !== null &&
    typeof (parsed.v as any).message_id === 'number'
  ) {
    summary.responseMessageId = (parsed.v as any).message_id;
  }
  if (parsed.p === 'response/status' && parsed.v === 'FINISHED') summary.finished = true;
  if (parsed.finish_reason || parsed.v === 'FINISHED') summary.finished = true;
}
