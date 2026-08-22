/**
 * Userscript port of core/memory/selector.ts and core/token/estimator.ts.
 *
 * The scoring weights, decay curve, budget shrink rule and formatted line
 * shape are copied verbatim: they determine which memories the model sees, so
 * any drift here would change personalization behavior.
 */

import type { Memory, SupportedLocale } from '../types';
import { MEMORY_TOKEN_BUDGET, STOP_WORDS } from '../constants';
import { translate } from '../i18n';

// Per DeepSeek's official guidance: 1 CJK char ~= 0.6 token, 1 ASCII ~= 0.3.
export function estimateTokenUnits(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += char.charCodeAt(0) > 0x7f ? 0.6 : 0.3;
  }
  return tokens;
}

export function estimateTokens(text: string): number {
  return Math.ceil(estimateTokenUnits(text));
}

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    : null;

const SEGMENT_CACHE_LIMIT = 1000;
const segmentCache = new Map<string, string[]>();

/** Word segmentation with an LRU-ish cache; falls back to punctuation splits. */
export function segmentText(text: string): string[] {
  const cached = segmentCache.get(text);
  if (cached) return cached;

  const words = segmenter
    ? [...segmenter.segment(text)]
        .filter((segment) => segment.isWordLike)
        .map((segment) => segment.segment.toLowerCase())
        .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    : text
        .toLowerCase()
        .split(/[\s,，。！？；：、\-_/]+/)
        .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  if (segmentCache.size >= SEGMENT_CACHE_LIMIT) {
    const firstKey = segmentCache.keys().next().value;
    if (firstKey !== undefined) segmentCache.delete(firstKey);
  }
  segmentCache.set(text, words);
  return words;
}

function keywordScore(promptWords: string[], memory: Memory): number {
  const promptSet = new Set(promptWords);

  let tagHits = 0;
  for (const tag of memory.tags) {
    const tagLower = tag.toLowerCase();
    if (tagLower.length > 1 && promptSet.has(tagLower)) tagHits++;
    for (const promptWord of promptWords) {
      if (promptWord.length > 2 && tagLower.includes(promptWord) && tagLower !== promptWord) {
        tagHits += 0.5;
      }
    }
  }

  const nameWords = segmentText(memory.name);
  let nameHits = 0;
  for (const word of nameWords) {
    if (promptSet.has(word)) nameHits++;
  }

  const contentWords = segmentText(memory.content);
  let contentHits = 0;
  for (const word of contentWords) {
    if (promptSet.has(word)) contentHits++;
  }

  return tagHits * 20 + nameHits * 15 + contentHits * 5;
}

function decayScore(memory: Memory): number {
  const daysSinceAccess = (Date.now() - memory.lastAccessedAt) / 86_400_000;
  const freshness = Math.max(0, 10 - daysSinceAccess * 0.1);
  return Math.min(memory.accessCount, 20) + freshness;
}

export interface SelectOptions {
  budget?: number;
  /** Restricts candidates to identity-defining memories (used by Skills). */
  identityOnly?: boolean;
}

/** Long prompts get a smaller memory budget, floored at 800 tokens. */
export function getMemoryBudget(promptTokens: number): number {
  if (promptTokens > 3000) {
    return Math.max(800, MEMORY_TOKEN_BUDGET - Math.floor((promptTokens - 3000) * 0.2));
  }
  return MEMORY_TOKEN_BUDGET;
}

export function selectMemories(
  prompt: string,
  allMemories: readonly Memory[],
  options?: SelectOptions,
): Memory[] {
  if (allMemories.length === 0) return [];

  const { budget = MEMORY_TOKEN_BUDGET, identityOnly = false } = options ?? {};

  const candidates = identityOnly
    ? allMemories.filter(
        (memory) => memory.type === 'user' || memory.type === 'feedback' || memory.pinned,
      )
    : allMemories;

  if (candidates.length === 0) return [];

  const promptWords = segmentText(prompt);

  const scored = candidates.map((memory) => ({
    memory,
    score:
      (memory.pinned ? 1000 : 0) +
      keywordScore(promptWords, memory) +
      decayScore(memory) +
      (Date.now() - memory.lastAccessedAt < 3600_000 ? 5 : 0),
  }));

  scored.sort((left, right) => right.score - left.score);

  const selected: Memory[] = [];
  let remaining = budget;

  for (const { memory } of scored) {
    const cost = estimateTokens(formatMemoryLine(memory));
    if (remaining - cost < 0 && selected.length > 0) break;
    selected.push(memory);
    remaining -= cost;
  }

  return selected;
}

/** DeepSeek's DSML delimiter must never appear verbatim inside injected text. */
function sanitizeContent(text: string): string {
  return text.replace(/｜DSML｜/g, '|DSML|');
}

export function formatMemoryLine(memory: Memory): string {
  const idPrefix = memory.id != null ? `#${memory.id} ` : '';
  const scopePrefix = memory.scope === 'project' ? 'project ' : '';
  return `- ${idPrefix}[${scopePrefix}${memory.type}] ${sanitizeContent(memory.name)}: ${sanitizeContent(memory.content)}`;
}

export function formatMemoriesBlock(
  memories: readonly Memory[],
  locale: SupportedLocale = 'zh-CN',
): string {
  if (memories.length === 0) return translate(locale, 'memoryEmpty');
  return memories.map(formatMemoryLine).join('\n');
}
