/**
 * Userscript port of core/interceptor/fetch-hook.ts.
 *
 * Installs three hooks on the page:
 *
 *  - fetch:  augment chat requests, filter the SSE response, clean history
 *  - XHR:    same, for the transport DeepSeek uses in some builds
 *  - IndexedDB: clean DeepSeek's local `history-message` cache on read
 *
 * A userscript running at document-start in the page context can patch these
 * before the app's bundle captures them, which is what makes the extension's
 * MAIN-world approach reproducible here without a content-script bridge.
 *
 * Fail-open is a hard rule: if augmentation throws, the original request bytes
 * are sent. A memory feature must never be able to break the user's chat.
 */

import type { ToolCall, ToolDescriptor } from '../types';
import { SCRIPT_NAME } from '../constants';
import { matchDeepSeekRoute, decodeDeepSeekRequestBody, isAugmentableRoute } from '../deepseek/routes';
import {
  consumeSseFrames,
  createDeepSeekSseFrameDecoder,
  createDeepSeekStreamSummary,
} from '../deepseek/sse';
import { XmlToolStreamFilter, type FrameSink } from './stream-filter';
import { stripToolCallsFromHistory, stripToolCallsFromIDBResult } from './history-cleanup';
import { createStreamingToolTextAccumulator, createToolCallScanGate } from '../tool/streaming-text';
import { extractToolCalls } from '../tool/parser';

export interface RequestBodyModification {
  body: string;
  originalPrompt: string;
}

export interface HookState {
  toolDescriptors: ToolDescriptor[];
  onRequestBody: (
    body: string,
    requestId: string,
  ) => Promise<RequestBodyModification | null>;
  onToolCall: (call: ToolCall) => void;
  onResponseComplete: (payload: { requestId: string; text: string }) => void;
}

const FETCH_HOOK_MARKER = Symbol.for('dspp-userscript-fetch-hook');
const XHR_HOOK_MARKER = Symbol.for('dspp-userscript-xhr-hook');
const IDB_HOOK_MARKER = Symbol.for('dspp-userscript-idb-hook');

let hookState: HookState = {
  toolDescriptors: [],
  onRequestBody: async () => null,
  onToolCall: () => undefined,
  onResponseComplete: () => undefined,
};

/**
 * Requests can start before the memory store has loaded. The hook waits a
 * bounded time for the first state update rather than sending an un-augmented
 * first message.
 */
const INITIAL_STATE_WAIT_MS = 3000;
let initialStateReady = false;
let resolveInitialState: (() => void) | null = null;
const initialStatePromise = new Promise<void>((resolve) => {
  resolveInitialState = resolve;
});

export function updateHookState(partial: Partial<HookState>): void {
  hookState = { ...hookState, ...partial };
  if (Object.prototype.hasOwnProperty.call(partial, 'toolDescriptors')) {
    initialStateReady = true;
    resolveInitialState?.();
  }
}

async function waitForInitialState(): Promise<void> {
  if (initialStateReady) return;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    initialStatePromise,
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, INITIAL_STATE_WAIT_MS);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  initialStateReady = true;
}

let requestSequence = 0;
function createRequestId(): string {
  requestSequence += 1;
  return `req-${Date.now().toString(36)}-${requestSequence}`;
}

/**
 * Installs one hook in isolation.
 *
 * A hook can legitimately fail: the userscript sandbox may expose `fetch` as a
 * getter-only property, and `IDBObjectStore` is absent in privacy modes. Those
 * failures must degrade the affected feature only — they must never abort
 * `installNetworkHooks`, because the caller mounts the UI panel afterwards.
 */
function installHook(name: string, install: () => () => void): (() => void) | null {
  try {
    return install();
  } catch (error) {
    console.warn(`[${SCRIPT_NAME}] ${name} hook unavailable, feature degraded`, error);
    return null;
  }
}

export function installNetworkHooks(): () => void {
  const cleanups: Array<() => void> = [];
  for (const [name, install] of [
    ['fetch', hookFetch],
    ['XHR', hookXhr],
    ['IndexedDB', hookIndexedDb],
  ] as Array<[string, () => () => void]>) {
    const cleanup = installHook(name, install);
    if (cleanup) cleanups.push(cleanup);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

interface RequestContext {
  requestId: string;
  originalPrompt: string;
  toolDescriptors: ToolDescriptor[];
  /** Descriptors used only for display filtering, never for execution. */
  filterToolDescriptors: ToolDescriptor[];
}

// --- fetch -------------------------------------------------------------------

function hookFetch(): () => void {
  const currentFetch = window.fetch as
    | (typeof window.fetch & { [FETCH_HOOK_MARKER]?: true })
    | undefined;
  if (typeof currentFetch !== 'function') return () => undefined;
  if (currentFetch[FETCH_HOOK_MARKER]) return () => undefined;
  const originalFetch = currentFetch as typeof window.fetch;

  const hookedFetch = async function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : null;
    const method =
      init?.method !== undefined
        ? init.method
        : input instanceof Request
          ? input.method
          : 'GET';
    const route =
      url !== null && typeof method === 'string'
        ? matchDeepSeekRoute({ url, method, baseUrl: document.baseURI })
        : null;

    if (route === 'history') {
      return interceptHistoryResponse(originalFetch.call(this, input, init));
    }

    if (!isAugmentableRoute(route) || typeof init?.body !== 'string') {
      return originalFetch.call(this, input, init);
    }

    await waitForInitialState();

    const requestId = createRequestId();
    const fallbackDescriptors = [...hookState.toolDescriptors];
    let modified: RequestBodyModification | null = null;
    let augmentationFailed = false;
    try {
      modified = await hookState.onRequestBody(init.body, requestId);
    } catch (error) {
      // Fail open: an augmentation bug must not turn into a failed chat.
      augmentationFailed = true;
      console.error('[DeepSeek++] request augmentation failed; sending original request', error);
    }

    const requestBody = modified?.body ?? init.body;
    const executableDescriptors = augmentationFailed ? [] : fallbackDescriptors;
    const context: RequestContext = {
      requestId,
      originalPrompt: modified?.originalPrompt ?? '',
      toolDescriptors: executableDescriptors,
      filterToolDescriptors: augmentationFailed ? fallbackDescriptors : executableDescriptors,
    };

    const requestInit = modified ? { ...init, body: modified.body } : init;
    return interceptStreamingResponse(
      originalFetch.call(this, input, requestInit),
      context,
    );
  };

  Object.defineProperty(hookedFetch, FETCH_HOOK_MARKER, { value: true, configurable: true });

  // Plain assignment throws in sandboxes that expose `fetch` as an accessor
  // without a setter; fall back to redefining the property.
  try {
    window.fetch = hookedFetch as typeof window.fetch;
  } catch {
    Object.defineProperty(window, 'fetch', {
      value: hookedFetch,
      writable: true,
      configurable: true,
    });
  }

  return () => {
    if (window.fetch !== hookedFetch) return;
    try {
      window.fetch = originalFetch;
    } catch {
      Object.defineProperty(window, 'fetch', {
        value: originalFetch,
        writable: true,
        configurable: true,
      });
    }
  };
}

/** Wraps the SSE body in a filtered stream. */
async function interceptStreamingResponse(
  responsePromise: Promise<Response>,
  context: RequestContext,
): Promise<Response> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch (error) {
    throw error;
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const streamState = createStreamState(context);
  let cancelled = false;
  let finished = false;

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (cancelled || finished) return;
        try {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (!done) {
            streamState.append(decoder.decode(value, { stream: true }), controller);
            return;
          }
          const finalText = decoder.decode();
          if (finalText) streamState.append(finalText, controller);
          streamState.finish(controller);
          finished = true;
          controller.close();
        } catch (error) {
          cancelled = true;
          try {
            await reader.cancel(error);
          } finally {
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        if (cancelled || finished) return;
        cancelled = true;
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );

  // The filtered body no longer matches the upstream length, and fetch already
  // decompressed it: stale content-length/encoding headers would break parsing.
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

interface StreamState {
  append(text: string, controller: ReadableStreamDefaultController<Uint8Array>): void;
  finish(controller: ReadableStreamDefaultController<Uint8Array>): void;
}

function createStreamState(context: RequestContext): StreamState {
  const frameDecoder = createDeepSeekSseFrameDecoder();
  const summary = createDeepSeekStreamSummary();
  const filter = new XmlToolStreamFilter(context.filterToolDescriptors, context.originalPrompt);
  const accumulator = createStreamingToolTextAccumulator(context.toolDescriptors);
  const scanGate = createToolCallScanGate(context.toolDescriptors);
  const encoder = new TextEncoder();
  const dispatchedCallRaw = new Set<string>();
  let rawToolText = '';
  let completed = false;

  const createSink = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): FrameSink => ({
    emit(block, separator) {
      controller.enqueue(encoder.encode(block + separator));
    },
  });

  const processFrames = (
    frames: ReturnType<typeof frameDecoder.push>,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => {
    if (frames.length === 0) return;
    consumeSseFrames(frames, summary, (parsed) => {
      const text = extractTextForTools(parsed);
      if (!text) return;
      accumulator.append(text);
      rawToolText += text;
      // Only re-scan when a closing tag arrived: parsing the whole buffer on
      // every delta is O(n^2) over a long reply.
      if (!scanGate.shouldScanChunk(text)) return;
      for (const call of extractToolCalls(rawToolText, context.toolDescriptors)) {
        if (dispatchedCallRaw.has(call.raw)) continue;
        dispatchedCallRaw.add(call.raw);
        hookState.onToolCall(call);
      }
    });
    filter.processFrames(frames, createSink(controller));
  };

  return {
    append(text, controller) {
      processFrames(frameDecoder.push(text), controller);
    },
    finish(controller) {
      if (completed) return;
      completed = true;
      processFrames(frameDecoder.finish(), controller);
      filter.flush(createSink(controller));
      const visibleText = accumulator.flush();
      hookState.onResponseComplete({ requestId: context.requestId, text: visibleText });
    },
  };
}

function extractTextForTools(parsed: unknown): string | null {
  // Tool XML may appear in either answer or reasoning fragments; the executor
  // needs both so a call emitted mid-reasoning is still detected.
  const value = parsed as { o?: unknown; v?: unknown; p?: unknown } | null;
  if (!value || typeof value !== 'object') return null;
  if (value.o === 'BATCH' && Array.isArray(value.v)) {
    const text = value.v
      .map((item) => extractTextForTools(item))
      .filter((part): part is string => part !== null)
      .join('');
    return text.length > 0 ? text : null;
  }
  if (typeof value.v === 'string' && (!value.p || typeof value.p === 'string')) {
    return value.v;
  }
  if (Array.isArray(value.v)) {
    const parts: string[] = [];
    for (const item of value.v) {
      if (item && typeof item === 'object') {
        const fragment = item as { content?: unknown; text?: unknown };
        if (typeof fragment.content === 'string') parts.push(fragment.content);
        else if (typeof fragment.text === 'string') parts.push(fragment.text);
      }
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

// --- history ------------------------------------------------------------------

async function interceptHistoryResponse(
  responsePromise: Promise<Response>,
): Promise<Response> {
  const response = await responsePromise;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) return response;

  try {
    const json = await response.clone().json();
    stripToolCallsFromHistory(json, { toolDescriptors: hookState.toolDescriptors });
    return new Response(JSON.stringify(json), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    return response;
  }
}

// --- XHR ----------------------------------------------------------------------

function hookXhr(): () => void {
  const ctor = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  if (typeof ctor !== 'function') return () => undefined;
  const prototype = ctor.prototype as XMLHttpRequest & {
    [XHR_HOOK_MARKER]?: true;
  };
  if (prototype[XHR_HOOK_MARKER]) return () => undefined;

  const xhrRoutes = new WeakMap<XMLHttpRequest, ReturnType<typeof matchDeepSeekRoute>>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: any[]
  ) {
    const routeUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : null;
    const route =
      typeof method === 'string' && routeUrl !== null
        ? matchDeepSeekRoute({ method, url: routeUrl, baseUrl: document.baseURI })
        : null;
    xhrRoutes.set(this, route);
    return origOpen.apply(this, [method, url, ...rest] as any);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const route = xhrRoutes.get(this);
    if (isAugmentableRoute(route) && typeof body === 'string') {
      const xhr = this;
      const sendChatRequest = async () => {
        const requestId = createRequestId();
        const fallbackDescriptors = [...hookState.toolDescriptors];
        let modified: RequestBodyModification | null = null;
        let augmentationFailed = false;
        try {
          modified = await hookState.onRequestBody(body, requestId);
        } catch (error) {
          // XHR.send() cannot surface an async failure to the page; failing
          // open keeps DeepSeek's UI from hanging on a permanent spinner.
          augmentationFailed = true;
          console.error('[DeepSeek++] XHR augmentation failed; sending original request', error);
        }
        const requestBody = modified?.body ?? body;
        const executableDescriptors = augmentationFailed ? [] : fallbackDescriptors;
        setupXhrResponseInterceptor(xhr, {
          requestId,
          originalPrompt: modified?.originalPrompt ?? '',
          toolDescriptors: executableDescriptors,
          filterToolDescriptors: augmentationFailed ? fallbackDescriptors : executableDescriptors,
        });
        return origSend.call(xhr, requestBody);
      };

      void waitForInitialState()
        .then(sendChatRequest)
        .catch((error) => console.error('[DeepSeek++] intercepted XHR request failed', error));
      return;
    }
    if (route === 'history') setupXhrHistoryInterceptor(this);
    return origSend.call(this, body);
  };

  const hookedOpen = prototype.open;
  const hookedSend = prototype.send;
  Object.defineProperty(prototype, XHR_HOOK_MARKER, { value: true, configurable: true });
  return () => {
    if (prototype.open === hookedOpen) prototype.open = origOpen;
    if (prototype.send === hookedSend) prototype.send = origSend;
    delete prototype[XHR_HOOK_MARKER];
  };
}

function setupXhrResponseInterceptor(xhr: XMLHttpRequest, context: RequestContext): void {
  let lastLen = 0;
  let filteredResponse = '';
  const streamState = createStreamState(context);
  let responseFinished = false;

  const origResponseTextDesc =
    Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText') ||
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(XMLHttpRequest.prototype),
      'responseText',
    );

  // A minimal controller that accumulates the filtered bytes as text.
  const fakeController = {
    enqueue(data: Uint8Array) {
      filteredResponse += new TextDecoder().decode(data);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;

  const consumeAvailableResponse = () => {
    const raw = origResponseTextDesc?.get?.call(xhr) || '';
    const newData = raw.slice(lastLen);
    lastLen = raw.length;
    if (newData) streamState.append(newData, fakeController);
  };
  const finishResponse = () => {
    if (responseFinished) return;
    consumeAvailableResponse();
    streamState.finish(fakeController);
    responseFinished = true;
  };
  const finishSuccessfulResponse = () => {
    // XHR reaches DONE on abort/error too; a non-zero status distinguishes a
    // real completion from a failure.
    if (xhr.readyState === 4 && xhr.status !== 0) finishResponse();
  };

  xhr.addEventListener('readystatechange', () => {
    if (xhr.readyState === 3 || xhr.readyState === 4) {
      consumeAvailableResponse();
      finishSuccessfulResponse();
    }
  });
  xhr.addEventListener('load', () => finishResponse(), { once: true });

  Object.defineProperty(xhr, 'responseText', {
    get() {
      if (xhr.readyState === 3 || xhr.readyState === 4) consumeAvailableResponse();
      finishSuccessfulResponse();
      return filteredResponse;
    },
    configurable: true,
  });
  Object.defineProperty(xhr, 'response', {
    get() {
      if (xhr.responseType === '' || xhr.responseType === 'text') {
        if (xhr.readyState === 3 || xhr.readyState === 4) consumeAvailableResponse();
        finishSuccessfulResponse();
        return filteredResponse;
      }
      return undefined;
    },
    configurable: true,
  });
}

function setupXhrHistoryInterceptor(xhr: XMLHttpRequest): void {
  const origResponseTextDesc =
    Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText') ||
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(XMLHttpRequest.prototype),
      'responseText',
    );
  if (!origResponseTextDesc?.get) return;

  let cleanedText: string | null = null;
  const cleanResponse = (): string => {
    if (cleanedText !== null) return cleanedText;
    const raw = String(origResponseTextDesc.get!.call(xhr) || '');
    if (xhr.readyState !== 4) return raw;
    let cleaned: string;
    try {
      const json = JSON.parse(raw);
      stripToolCallsFromHistory(json, { toolDescriptors: hookState.toolDescriptors });
      cleaned = JSON.stringify(json);
    } catch {
      cleaned = raw;
    }
    cleanedText = cleaned;
    return cleaned;
  };

  Object.defineProperty(xhr, 'responseText', {
    get: cleanResponse,
    configurable: true,
  });
  Object.defineProperty(xhr, 'response', {
    get() {
      if (xhr.responseType === '' || xhr.responseType === 'text') return cleanResponse();
      return undefined;
    },
    configurable: true,
  });
}

// --- IndexedDB ------------------------------------------------------------------

function hookIndexedDb(): () => void {
  // Absent in some privacy modes / embedded webviews.
  const ctor = (globalThis as { IDBObjectStore?: typeof IDBObjectStore }).IDBObjectStore;
  if (typeof ctor !== 'function') return () => undefined;
  const prototype = ctor.prototype as IDBObjectStore & {
    [IDB_HOOK_MARKER]?: true;
  };
  if (prototype[IDB_HOOK_MARKER]) return () => undefined;
  const origGet = prototype.get;
  const origGetAll = prototype.getAll;

  prototype.get = function (...args: any[]) {
    const request = origGet.apply(this, args as any);
    if (this.name === 'history-message') patchIdbRequest(request);
    return request;
  };

  prototype.getAll = function (...args: any[]) {
    const request = origGetAll.apply(this, args as any);
    if (this.name === 'history-message') patchIdbRequest(request);
    return request;
  };

  const hookedGet = prototype.get;
  const hookedGetAll = prototype.getAll;
  Object.defineProperty(prototype, IDB_HOOK_MARKER, { value: true, configurable: true });
  return () => {
    if (prototype.get === hookedGet) prototype.get = origGet;
    if (prototype.getAll === hookedGetAll) prototype.getAll = origGetAll;
    delete prototype[IDB_HOOK_MARKER];
  };
}

function patchIdbRequest(request: IDBRequest): void {
  const origResultDesc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
  if (!origResultDesc?.get) return;

  let cleaned = false;
  Object.defineProperty(request, 'result', {
    get() {
      const result = origResultDesc.get!.call(this);
      if (result && !cleaned) {
        cleaned = true;
        try {
          stripToolCallsFromIDBResult(result, {
            toolDescriptors: hookState.toolDescriptors,
          });
        } catch (error) {
          console.error('[DeepSeek++] history cleanup failed', error);
        }
      }
      return result;
    },
    configurable: true,
  });
}
