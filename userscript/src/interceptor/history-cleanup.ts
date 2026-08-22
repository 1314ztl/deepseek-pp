/**
 * Userscript port of core/interceptor/history-cleanup.ts.
 *
 * Without this, reloading a conversation would show the full injected system
 * prompt as the user's message and the raw tool XML inside assistant replies,
 * because DeepSeek stores exactly what was sent and received.
 *
 * Both transports are covered: the history HTTP response and DeepSeek's own
 * IndexedDB `history-message` cache.
 */

import type { ToolDescriptor } from '../types';
import { sanitizeInternalPromptText } from '../prompt/visibility';
import { hasToolCallMarker, stripToolCalls } from '../tool/parser';

export interface HistoryCleanupOptions {
  toolDescriptors: readonly ToolDescriptor[];
}

export function stripToolCallsFromHistory(json: any, options: HistoryCleanupOptions): void {
  if (!json || !json.data) return;
  const data = json.data.biz_data || json.data;
  const messages = data.chat_messages;
  if (!Array.isArray(messages)) return;
  cleanMessages(messages, options.toolDescriptors);
}

export function stripToolCallsFromIDBResult(result: any, options: HistoryCleanupOptions): void {
  if (Array.isArray(result)) {
    for (const item of result) cleanSingleIdbRecord(item, options.toolDescriptors);
    return;
  }
  cleanSingleIdbRecord(result, options.toolDescriptors);
}

function cleanSingleIdbRecord(record: any, toolDescriptors: readonly ToolDescriptor[]): void {
  if (!record || !record.data) return;
  const messages = record.data.chat_messages;
  if (!Array.isArray(messages)) return;
  cleanMessages(messages, toolDescriptors);
}

function cleanMessages(messages: any[], toolDescriptors: readonly ToolDescriptor[]): void {
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;

    // 1. Restore the user's real text from the augmented prompt.
    if (typeof message.content === 'string') {
      message.content = sanitizeInternalPromptText(message.content);
    }
    sanitizeFragments(message.fragments);

    // 2. Remove executed tool XML from assistant messages.
    if (typeof message.content === 'string' && hasToolCallMarker(message.content, toolDescriptors)) {
      message.content = stripToolCalls(message.content, toolDescriptors);
    }
    stripFragmentToolCalls(message.fragments, toolDescriptors);
  }
}

function sanitizeFragments(fragments: unknown): void {
  if (!Array.isArray(fragments)) return;
  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== 'object') continue;
    if (typeof fragment.content === 'string') {
      fragment.content = sanitizeInternalPromptText(fragment.content);
    }
  }
}

/**
 * Fragment-aware tool stripping. DeepSeek splits one message across THINK and
 * RESPONSE fragments, and a tool block can straddle a fragment boundary, so the
 * text is joined, stripped, then redistributed. RESPONSE fragments are kept
 * separate from THINK fragments: merging them would turn a rendered deliverable
 * into plain reasoning text after a refresh.
 */
function stripFragmentToolCalls(
  fragments: unknown,
  toolDescriptors: readonly ToolDescriptor[],
): void {
  if (!Array.isArray(fragments)) return;

  const textFragments = fragments.filter(
    (fragment: any) => fragment && typeof fragment.content === 'string',
  ) as Array<{ content: string; type?: string }>;
  if (textFragments.length === 0) return;

  const responseFragments = textFragments.filter(
    (fragment) => typeof fragment.type === 'string' && fragment.type.toUpperCase() === 'RESPONSE',
  );
  const thinkFragments = textFragments.filter(
    (fragment) => !(typeof fragment.type === 'string' && fragment.type.toUpperCase() === 'RESPONSE'),
  );

  if (responseFragments.length > 0) {
    stripFragmentGroup(thinkFragments, toolDescriptors);
    stripFragmentGroup(responseFragments, toolDescriptors);
    return;
  }

  stripFragmentGroup(textFragments, toolDescriptors);
}

function stripFragmentGroup(
  fragments: Array<{ content: string }>,
  toolDescriptors: readonly ToolDescriptor[],
): void {
  if (fragments.length === 0) return;
  const text = fragments.map((fragment) => fragment.content).join('');
  if (!hasToolCallMarker(text, toolDescriptors)) return;

  const stripped = stripToolCalls(text, toolDescriptors);
  // Put the whole stripped text in the first fragment and clear the rest: the
  // original per-fragment offsets no longer exist after removal.
  fragments[0].content = stripped;
  for (let index = 1; index < fragments.length; index++) {
    fragments[index].content = '';
  }
}
