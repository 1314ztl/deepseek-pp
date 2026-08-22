/**
 * Userscript port of the XmlToolStreamFilter in core/interceptor/fetch-hook.ts.
 *
 * Two jobs, both on the live SSE stream:
 *
 *  1. Strip tool-call XML out of the text DeepSeek's own UI renders, so the
 *     user sees prose instead of `<memory_save>{...}</memory_save>`.
 *  2. Replace the echoed request message with the user's real text, so the
 *     injected system prompt never shows up as the user's bubble.
 *
 * Both require rewriting frames rather than dropping them: DeepSeek's client
 * treats fragment-creation events as structural, so a dropped structural frame
 * desynchronizes its renderer. Hence the "clone the patch with modified text"
 * approach instead of filtering frames out wholesale.
 */

import type { ToolDescriptor } from '../types';
import { createToolInvocationCatalog } from '../tool/parser';
import { findFirstXmlToolTag, getPartialXmlToolTagTailLength } from '../tool/xml-tags';
import { sanitizeInternalPromptText } from '../prompt/visibility';
import {
  cloneParsedWithTextPrefix,
  cloneParsedWithTextSuffix,
  extractResponseTextFromParsed,
  getAnyDirectPatchText,
  isBatchPatch,
  isFragmentCreationPatch,
  isResponsePatch,
  replaceSseFrameData,
  setAnyDirectPatchText,
  type DeepSeekSseFrame,
} from '../deepseek/sse';

interface PendingBlock {
  block: string;
  separator: string;
  sourceFrame: DeepSeekSseFrame;
  isFragmentCreation: boolean;
  parsed: any;
}

export interface FrameSink {
  emit(block: string, separator: string): void;
}

export class XmlToolStreamFilter {
  private readonly toolNames: ReadonlySet<string>;
  private readonly visiblePrompt: string;
  private state: 'NORMAL' | 'SUPPRESSING' = 'NORMAL';
  private currentTool: string | null = null;
  private pendingText = '';
  private pendingBlocks: PendingBlock[] = [];
  /** Drop leading blank lines from the text right after a stripped block. */
  private stripTailLeadingNewlines = false;
  /** Whether the last emitted text ended with a newline (cross-frame state). */
  private lastEmittedTextEndsWithNewline = false;

  constructor(descriptors: readonly ToolDescriptor[] = [], visiblePrompt = '') {
    this.visiblePrompt = visiblePrompt;
    this.toolNames = new Set(createToolInvocationCatalog(descriptors).invocationNames);
  }

  processFrames(frames: readonly DeepSeekSseFrame[], sink: FrameSink): void {
    for (const frame of frames) {
      if (!frame.block.trim() || !frame.event || !frame.parsed) {
        sink.emit(frame.block, frame.separator);
        continue;
      }

      const sanitizedParsed = cloneParsedWithSanitizedInternalPrompt(
        frame.parsed,
        this.visiblePrompt,
      );
      const effectiveParsed = sanitizedParsed ?? frame.parsed;
      const effectiveBlock = sanitizedParsed
        ? replaceSseFrameData(frame, JSON.stringify(sanitizedParsed))
        : frame.block;
      const text = extractResponseTextFromParsed(effectiveParsed);
      if (text === null) {
        // Non-text events (ids, status, the request echo) pass through after
        // prompt cleanup.
        sink.emit(effectiveBlock, frame.separator);
        continue;
      }

      const isFragmentCreation = isFragmentCreationPatch(effectiveParsed);

      if (this.state === 'SUPPRESSING') {
        const previousPendingLength = this.pendingText.length;
        const searchText = this.pendingText + text;
        const closeTag = this.findFirstToolClose(searchText, this.currentTool!);
        if (closeTag) {
          const tailOffsetInCurrentText = closeTag.endIndex - previousPendingLength;
          const toolTail = this.getCurrentToolTail(
            effectiveParsed,
            text,
            isFragmentCreation,
            tailOffsetInCurrentText,
            frame,
          );
          this.state = 'NORMAL';
          this.pendingText = '';
          this.currentTool = null;
          this.stripTailLeadingNewlines = true;
          if (toolTail) {
            this.processNormalTextBlock(
              sink,
              toolTail.block,
              toolTail.separator,
              toolTail.sourceFrame,
              toolTail.parsed,
              toolTail.text,
              toolTail.isFragmentCreation,
            );
          }
          continue;
        }
        this.pendingText = this.getCloseSearchTail(searchText, this.currentTool!);
        // Structural frames must still reach the page, but with empty text.
        if (isFragmentCreation || isBatchPatch(effectiveParsed)) {
          const modified = cloneParsedWithTextPrefix(effectiveParsed, 0);
          if (modified) {
            sink.emit(replaceSseFrameData(frame, JSON.stringify(modified)), frame.separator);
          }
        }
        continue;
      }

      this.processNormalTextBlock(
        sink,
        effectiveBlock,
        frame.separator,
        frame,
        effectiveParsed,
        text,
        isFragmentCreation,
      );
    }
  }

  private processNormalTextBlock(
    sink: FrameSink,
    block: string,
    separator: string,
    sourceFrame: DeepSeekSseFrame,
    parsed: any,
    text: string,
    isFragmentCreation: boolean,
  ): void {
    if (this.stripTailLeadingNewlines) {
      const leadingNewlines = /^\n+/.exec(text);
      if (leadingNewlines) {
        const modified = cloneParsedWithTextSuffix(parsed, leadingNewlines[0].length);
        if (!modified) {
          // Nothing but blank lines: drop the frame and keep trimming the next.
          return;
        }
        const modifiedText = extractResponseTextFromParsed(modified);
        if (!modifiedText) return;
        parsed = modified;
        text = modifiedText;
        block = replaceSseFrameData(sourceFrame, JSON.stringify(modified));
      }
      this.stripTailLeadingNewlines = false;
    }

    const previousPendingLength = this.pendingText.length;
    this.pendingText += text;
    this.pendingBlocks.push({ block, separator, sourceFrame, isFragmentCreation, parsed });

    const found = this.findFirstToolOpen(this.pendingText);
    if (found) {
      const closeTag = this.findFirstToolClose(this.pendingText, found.name, found.endIndex);
      const tailStart = closeTag ? closeTag.endIndex : -1;
      const tailOffsetInCurrentText = tailStart - previousPendingLength;

      let textBeforeOpen = this.pendingText.slice(0, found.index);
      // Model output usually wraps tool calls in blank lines; collapse the run
      // before the open tag so the stripped result keeps one paragraph break.
      const collapsedBeforeOpen = textBeforeOpen.replace(/\n{3,}$/, '\n\n');
      const openIdx = found.index - (textBeforeOpen.length - collapsedBeforeOpen.length);
      textBeforeOpen = collapsedBeforeOpen;
      this.stripTailLeadingNewlines =
        textBeforeOpen.length > 0
          ? /\n$/.test(textBeforeOpen)
          : this.lastEmittedTextEndsWithNewline;
      this.emitBlocksBeforeOpen(sink, openIdx);
      this.pendingBlocks = [];

      if (!closeTag) {
        this.state = 'SUPPRESSING';
        this.currentTool = found.name;
        this.pendingText = this.getCloseSearchTail(
          this.pendingText.slice(found.index),
          found.name,
        );
        return;
      }

      this.state = 'NORMAL';
      this.currentTool = null;
      this.pendingText = '';
      const toolTail = this.getCurrentToolTail(
        parsed,
        text,
        isFragmentCreation,
        tailOffsetInCurrentText,
        sourceFrame,
      );
      if (toolTail) {
        this.processNormalTextBlock(
          sink,
          toolTail.block,
          toolTail.separator,
          toolTail.sourceFrame,
          toolTail.parsed,
          toolTail.text,
          toolTail.isFragmentCreation,
        );
      }
      return;
    }

    if (this.couldBePartialToolOpen(this.pendingText)) return;

    for (const pending of this.pendingBlocks) {
      sink.emit(pending.block, pending.separator);
    }
    this.lastEmittedTextEndsWithNewline = /\n$/.test(this.pendingText);
    this.pendingBlocks = [];
    this.pendingText = '';
  }

  /**
   * Emits buffered frames up to `openIdx`, truncating the frame that contains
   * the open tag so its pre-tag text is preserved.
   */
  private emitBlocksBeforeOpen(sink: FrameSink, openIdx: number): void {
    let consumed = 0;
    for (const pending of this.pendingBlocks) {
      const pendingText = extractResponseTextFromParsed(pending.parsed) ?? '';
      const blockStart = consumed;
      const blockEnd = consumed + pendingText.length;
      consumed = blockEnd;

      if (blockEnd <= openIdx) {
        sink.emit(pending.block, pending.separator);
        continue;
      }

      if (blockStart >= openIdx) {
        // Entirely inside the tool block: keep structural frames with no text.
        if (pending.isFragmentCreation || isBatchPatch(pending.parsed)) {
          const modified = cloneParsedWithTextPrefix(pending.parsed, 0);
          if (modified) {
            sink.emit(
              replaceSseFrameData(pending.sourceFrame, JSON.stringify(modified)),
              pending.separator,
            );
          }
        }
        continue;
      }

      const keepLength = openIdx - blockStart;
      const modified = cloneParsedWithTextPrefix(pending.parsed, keepLength);
      if (modified) {
        sink.emit(
          replaceSseFrameData(pending.sourceFrame, JSON.stringify(modified)),
          pending.separator,
        );
      }
    }
  }

  private getCurrentToolTail(
    parsed: any,
    text: string,
    isFragmentCreation: boolean,
    tailOffsetInCurrentText: number,
    sourceFrame: DeepSeekSseFrame,
  ): PendingBlock & { text: string } | null {
    if (tailOffsetInCurrentText >= text.length) return null;

    const modified = cloneParsedWithTextSuffix(parsed, Math.max(0, tailOffsetInCurrentText));
    if (!modified) return null;

    const modifiedText = extractResponseTextFromParsed(modified);
    if (!modifiedText) return null;

    return {
      block: replaceSseFrameData(sourceFrame, JSON.stringify(modified)),
      separator: sourceFrame.separator,
      sourceFrame,
      parsed: modified,
      text: modifiedText,
      isFragmentCreation: isFragmentCreation || isFragmentCreationPatch(modified),
    };
  }

  private findFirstToolOpen(text: string) {
    return findFirstXmlToolTag(text, this.toolNames, { closing: false });
  }

  private findFirstToolClose(text: string, tool: string, fromIndex = 0) {
    return findFirstXmlToolTag(text, new Set([tool]), { closing: true, fromIndex });
  }

  private couldBePartialToolOpen(text: string): boolean {
    return getPartialXmlToolTagTailLength(text, this.toolNames, { closing: false }) > 0;
  }

  private getCloseSearchTail(text: string, tool: string): string {
    const tailLength = getPartialXmlToolTagTailLength(text, new Set([tool]), { closing: true });
    return tailLength > 0 ? text.slice(-tailLength) : '';
  }

  flush(sink: FrameSink): void {
    for (const pending of this.pendingBlocks) {
      sink.emit(pending.block, pending.separator);
    }
    this.pendingBlocks = [];
    this.pendingText = '';
  }
}

/**
 * Rewrites any frame text that still carries internal prompt markers. The
 * echoed request message becomes the user's real text; a response fragment
 * that leaked a reminder is emptied.
 */
export function cloneParsedWithSanitizedInternalPrompt(
  parsed: any,
  visiblePrompt: string,
): any | null {
  const cloned = JSON.parse(JSON.stringify(parsed));
  let changed = false;

  const apply = (node: any): void => {
    if (!node || typeof node !== 'object') return;

    if (isBatchPatch(node)) {
      for (const item of node.v) apply(item);
      return;
    }

    const text = getAnyDirectPatchText(node);
    if (text === null) return;

    const isResponseText = isResponsePatch(node);
    const sanitized = sanitizeInternalPromptText(
      text,
      isResponseText ? undefined : visiblePrompt,
    );
    if (sanitized === text) return;

    setAnyDirectPatchText(node, isResponseText ? '' : sanitized);
    changed = true;
  };

  apply(cloned);

  return changed ? cloned : null;
}
