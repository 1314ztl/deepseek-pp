/**
 * Userscript port of core/interceptor/streaming-tool-text.ts.
 *
 * Accumulates the model's streamed text while suppressing tool XML, so the
 * "visible text" the userscript reports for a turn matches what the page shows.
 * A tag split across chunk boundaries is held back via the partial-tail scan
 * instead of being emitted half-open.
 */

import type { ToolDescriptor } from '../types';
import { createToolInvocationCatalog } from './parser';
import {
  findFirstXmlToolTag,
  getPartialXmlToolTagTailLength,
  getToolCloseTag,
} from './xml-tags';

export interface StreamingToolTextAccumulator {
  append(chunk: string): string;
  flush(): string;
  getVisibleText(): string;
}

export function createStreamingToolTextAccumulator(
  descriptors: readonly ToolDescriptor[],
): StreamingToolTextAccumulator {
  return new ToolTextAccumulator(createToolInvocationCatalog(descriptors).invocationNames);
}

class ToolTextAccumulator implements StreamingToolTextAccumulator {
  private readonly toolNames: ReadonlySet<string>;
  private state: 'NORMAL' | 'SUPPRESSING' = 'NORMAL';
  private currentTool: string | null = null;
  private pendingNormal = '';
  private pendingSuppressed = '';
  private visibleText = '';

  constructor(invocationNames: readonly string[]) {
    this.toolNames = new Set(invocationNames);
  }

  append(chunk: string): string {
    if (!chunk || this.toolNames.size === 0) {
      this.visibleText += chunk;
      return this.visibleText;
    }

    let remaining = chunk;
    while (remaining.length > 0) {
      remaining =
        this.state === 'SUPPRESSING'
          ? this.consumeSuppressedText(remaining)
          : this.consumeNormalText(remaining);
    }

    return this.visibleText;
  }

  flush(): string {
    if (this.state === 'NORMAL' && this.pendingNormal) {
      this.visibleText += this.pendingNormal;
    }
    this.state = 'NORMAL';
    this.currentTool = null;
    this.pendingNormal = '';
    this.pendingSuppressed = '';
    return this.visibleText;
  }

  getVisibleText(): string {
    return this.visibleText;
  }

  private consumeNormalText(input: string): string {
    const text = this.pendingNormal + input;
    this.pendingNormal = '';

    const found = findFirstXmlToolTag(text, this.toolNames, { closing: false });
    if (!found) {
      const tailLength = getPartialXmlToolTagTailLength(text, this.toolNames, {
        closing: false,
      });
      const emitLength = text.length - tailLength;
      if (emitLength > 0) this.visibleText += text.slice(0, emitLength);
      this.pendingNormal = tailLength > 0 ? text.slice(-tailLength) : '';
      return '';
    }

    if (found.index > 0) this.visibleText += text.slice(0, found.index);

    this.state = 'SUPPRESSING';
    this.currentTool = found.name;
    this.pendingSuppressed = '';
    return text.slice(found.endIndex);
  }

  private consumeSuppressedText(input: string): string {
    const tool = this.currentTool;
    if (!tool) {
      this.state = 'NORMAL';
      return input;
    }

    const text = this.pendingSuppressed + input;
    this.pendingSuppressed = '';

    const closeMatch = findFirstXmlToolTag(text, new Set([tool]), { closing: true });
    if (!closeMatch) {
      const tailLength = getPartialXmlToolTagTailLength(text, new Set([tool]), {
        closing: true,
      });
      this.pendingSuppressed = tailLength > 0 ? text.slice(-tailLength) : '';
      return '';
    }

    this.state = 'NORMAL';
    this.currentTool = null;
    return text.slice(closeMatch.endIndex ?? closeMatch.index + getToolCloseTag(tool).length);
  }
}

/**
 * Gate used to avoid re-parsing the whole accumulated text on every chunk: it
 * returns true only when a closing tool tag has appeared, which is the only
 * moment a new complete call can exist.
 */
export function createToolCallScanGate(descriptors: readonly ToolDescriptor[]): {
  shouldScanChunk(text: string): boolean;
} {
  const catalog = createToolInvocationCatalog(descriptors);
  const toolNames = new Set(catalog.invocationNames);
  let tail = '';

  return {
    shouldScanChunk(text: string): boolean {
      if (!text || toolNames.size === 0) return false;
      const probe = tail + text;
      const tailLength = getPartialXmlToolTagTailLength(probe, toolNames, { closing: true });
      tail = tailLength > 0 ? probe.slice(-tailLength) : '';
      return Boolean(findFirstXmlToolTag(probe, toolNames, { closing: true }));
    },
  };
}
