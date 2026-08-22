/**
 * Regression tests for the hook-installation fail-safe.
 *
 * The userscript mounts its UI panel *after* installing network hooks. A hook
 * that throws must therefore degrade only its own feature — if it propagates,
 * the panel never mounts and the user is left with a silently dead script
 * (the `M+` button simply never appears).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installNetworkHooks } from '../src/interceptor/network-hook';

const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;
const originalIdb = globalThis.IDBObjectStore;

function restoreAll(): void {
  Object.defineProperty(globalThis, 'fetch', {
    value: originalFetch,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    value: originalXhr,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'IDBObjectStore', {
    value: originalIdb,
    writable: true,
    configurable: true,
  });
}

describe('installNetworkHooks resilience', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreAll();
    vi.restoreAllMocks();
  });

  it('does not throw when IDBObjectStore is unavailable', () => {
    Object.defineProperty(globalThis, 'IDBObjectStore', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(() => installNetworkHooks()()).not.toThrow();
  });

  it('does not throw when XMLHttpRequest is unavailable', () => {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(() => installNetworkHooks()()).not.toThrow();
  });

  it('does not throw when fetch is missing entirely', () => {
    Object.defineProperty(globalThis, 'fetch', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(() => installNetworkHooks()()).not.toThrow();
  });

  it('still hooks fetch when the property is getter-only', () => {
    const sandboxFetch = (async () => new Response('{}')) as typeof fetch;
    Object.defineProperty(globalThis, 'fetch', {
      get: () => sandboxFetch,
      configurable: true,
    });

    let dispose: () => void = () => undefined;
    expect(() => {
      dispose = installNetworkHooks();
    }).not.toThrow();

    // The accessor had no setter, so the hook must have redefined the property.
    expect(globalThis.fetch).not.toBe(sandboxFetch);
    expect(() => dispose()).not.toThrow();
  });

  it('installs the surviving hooks even when one is broken', () => {
    Object.defineProperty(globalThis, 'IDBObjectStore', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const before = globalThis.fetch;

    const dispose = installNetworkHooks();
    expect(globalThis.fetch).not.toBe(before);

    dispose();
    expect(globalThis.fetch).toBe(before);
  });

  it('is idempotent across repeated installs', () => {
    const dispose1 = installNetworkHooks();
    const hooked = globalThis.fetch;
    const dispose2 = installNetworkHooks();

    // The second install must detect the marker and leave the hook in place.
    expect(globalThis.fetch).toBe(hooked);

    dispose2();
    dispose1();
  });
});
