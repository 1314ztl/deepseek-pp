/**
 * Userscript port of core/interceptor/tool-parser.ts (XML path only).
 *
 * The extension also parsed a legacy `｜DSML｜tool_calls` wrapper format; that
 * path is dropped here because the current DeepSeek models emit the direct XML
 * tag form the system prompt asks for, and the userscript has no historical
 * conversations to stay compatible with.
 */

import type { ToolCall, ToolDescriptor, ToolError } from '../types';
import { findFirstXmlToolTag } from './xml-tags';

export interface ToolInvocationCatalog {
  descriptors: readonly ToolDescriptor[];
  invocationNames: string[];
  byInvocationName: Map<string, ToolDescriptor>;
}

export function createToolInvocationCatalog(
  descriptors: readonly ToolDescriptor[] = [],
): ToolInvocationCatalog {
  const byInvocationName = new Map<string, ToolDescriptor>();
  for (const descriptor of descriptors) {
    byInvocationName.set(descriptor.invocationName, descriptor);
    // The bare tool name is also accepted so a model that ignores the
    // invocation alias still produces an executable call.
    if (!byInvocationName.has(descriptor.name)) {
      byInvocationName.set(descriptor.name, descriptor);
    }
  }
  return {
    descriptors,
    invocationNames: [...byInvocationName.keys()],
    byInvocationName,
  };
}

let callSequence = 0;

function createToolCallId(): string {
  callSequence += 1;
  return `dspp-${Date.now().toString(36)}-${callSequence}`;
}

function createToolParseError(code: string, invocationName: string, message: string): ToolError {
  return { code, message: `${invocationName}: ${message}`, retryable: false };
}

function createToolCallFromInvocation(
  invocationName: string,
  payload: Record<string, unknown>,
  raw: string,
  catalog: ToolInvocationCatalog,
  options?: { parseError?: ToolError },
): ToolCall {
  const descriptor = catalog.byInvocationName.get(invocationName);
  return {
    id: createToolCallId(),
    name: descriptor?.name ?? invocationName,
    invocationName,
    descriptorId: descriptor?.id,
    payload,
    raw,
    ...(options?.parseError ? { parseError: options.parseError } : {}),
  };
}

/**
 * Extracts every complete `<tool>{...}</tool>` block. Malformed JSON produces a
 * call carrying a parseError instead of being silently dropped, so the user can
 * see that the model tried and failed to call a tool.
 */
export function extractToolCalls(
  text: string,
  descriptors: readonly ToolDescriptor[],
): ToolCall[] {
  const catalog = createToolInvocationCatalog(descriptors);
  const calls: ToolCall[] = [];
  const names = catalog.invocationNames;
  if (names.length === 0 || !text) return calls;
  const nameSet = new Set(names);
  let fromIndex = 0;

  while (fromIndex < text.length) {
    const open = findFirstXmlToolTag(text, nameSet, { closing: false, fromIndex });
    if (!open) break;
    const close = findFirstXmlToolTag(text, new Set([open.name]), {
      closing: true,
      fromIndex: open.endIndex,
    });
    if (!close) {
      fromIndex = open.endIndex;
      continue;
    }

    const raw = text.slice(open.index, close.endIndex);
    const body = text.slice(open.endIndex, close.index).trim();
    const invocationName = open.name;

    try {
      const parsed = body.length === 0 ? {} : JSON.parse(body);
      if (!isToolPayload(parsed)) {
        calls.push(
          createToolCallFromInvocation(invocationName, {}, raw, catalog, {
            parseError: createToolParseError(
              'tool_call_payload_invalid',
              invocationName,
              'Tool call body must be a JSON object.',
            ),
          }),
        );
        fromIndex = close.endIndex;
        continue;
      }
      calls.push(createToolCallFromInvocation(invocationName, parsed, raw, catalog));
    } catch (error) {
      calls.push(
        createToolCallFromInvocation(invocationName, {}, raw, catalog, {
          parseError: createToolParseError(
            'tool_call_json_invalid',
            invocationName,
            [
              'Tool call body is not valid JSON.',
              'Use double quotes for strings.',
              error instanceof Error ? error.message : String(error),
            ].join(' '),
          ),
        }),
      );
    }
    fromIndex = close.endIndex;
  }

  return calls;
}

/** Removes every complete tool block from text (used for history cleanup). */
export function stripToolCalls(text: string, descriptors: readonly ToolDescriptor[]): string {
  const catalog = createToolInvocationCatalog(descriptors);
  const blocks = collectXmlToolCallBlocks(text, catalog);
  return removeBlocks(text, blocks).trim();
}

export function hasToolCallMarker(
  text: string,
  descriptors: readonly ToolDescriptor[],
): boolean {
  const catalog = createToolInvocationCatalog(descriptors);
  const nameSet = new Set(catalog.invocationNames);
  if (nameSet.size === 0) return false;
  return Boolean(findFirstXmlToolTag(text, nameSet, { closing: false }));
}

interface ToolBlock {
  start: number;
  end: number;
}

function collectXmlToolCallBlocks(
  text: string,
  catalog: ToolInvocationCatalog,
): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  const nameSet = new Set(catalog.invocationNames);
  if (nameSet.size === 0 || !text) return blocks;
  let fromIndex = 0;

  while (fromIndex < text.length) {
    const open = findFirstXmlToolTag(text, nameSet, { closing: false, fromIndex });
    if (!open) break;
    const close = findFirstXmlToolTag(text, new Set([open.name]), {
      closing: true,
      fromIndex: open.endIndex,
    });
    if (!close) {
      fromIndex = open.endIndex;
      continue;
    }
    blocks.push({ start: open.index, end: close.endIndex });
    fromIndex = close.endIndex;
  }

  return blocks;
}

function removeBlocks(text: string, blocks: readonly ToolBlock[]): string {
  if (blocks.length === 0) return text;
  let result = '';
  let cursor = 0;
  for (const block of blocks) {
    result += text.slice(cursor, block.start);
    cursor = block.end;
  }
  result += text.slice(cursor);
  // Collapse the blank-line stack left behind by a removed block.
  return result.replace(/\n{3,}/g, '\n\n');
}

function isToolPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
