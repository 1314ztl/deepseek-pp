/**
 * Userscript replacement for `chrome.storage.local`.
 *
 * The extension used a background-owned chrome.storage slot; a userscript has
 * two options: the Tampermonkey GM_* value API (survives page-origin data
 * clearing and is shared across DeepSeek subdomains) or localStorage. GM_* is
 * preferred and localStorage is the fallback so the script still works when
 * granted no GM permissions.
 *
 * All values are JSON-encoded, matching the extension's storage payloads, so
 * settings/presets can be copied over verbatim.
 */

type GmGetValue = (key: string, fallback?: string) => string | undefined;
type GmSetValue = (key: string, value: string) => void;
type GmDeleteValue = (key: string) => void;
type GmListValues = () => string[];

interface GmApi {
  getValue: GmGetValue;
  setValue: GmSetValue;
  deleteValue: GmDeleteValue;
  listValues: GmListValues;
}

function resolveGmApi(): GmApi | null {
  const scope = globalThis as unknown as Record<string, unknown>;
  const getValue = scope.GM_getValue as GmGetValue | undefined;
  const setValue = scope.GM_setValue as GmSetValue | undefined;
  const deleteValue = scope.GM_deleteValue as GmDeleteValue | undefined;
  const listValues = scope.GM_listValues as GmListValues | undefined;
  if (!getValue || !setValue) return null;
  return {
    getValue,
    setValue,
    deleteValue: deleteValue ?? (() => undefined),
    listValues: listValues ?? (() => []),
  };
}

const gm = resolveGmApi();

export const storageBackend: 'gm' | 'localStorage' = gm ? 'gm' : 'localStorage';

function readRaw(key: string): string | null {
  if (gm) {
    const value = gm.getValue(key);
    return typeof value === 'string' ? value : null;
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  if (gm) {
    gm.setValue(key, value);
    return;
  }
  localStorage.setItem(key, value);
}

function removeRaw(key: string): void {
  if (gm) {
    gm.deleteValue(key);
    return;
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage disabled */
  }
}

export interface RawStorageSlot {
  present: boolean;
  value: unknown;
}

/**
 * Reads a slot without collapsing "absent" into "null". The extension's
 * versioned repository relies on that distinction to tell a never-written key
 * from an explicitly stored null, so the port keeps it.
 */
export function readSlot(key: string): RawStorageSlot {
  const raw = readRaw(key);
  if (raw === null) return { present: false, value: undefined };
  try {
    return { present: true, value: JSON.parse(raw) };
  } catch {
    // A corrupt slot must fail visibly rather than silently resetting user data.
    throw new Error(`Storage slot ${key} is not valid JSON`);
  }
}

export function writeSlot(key: string, value: unknown): void {
  writeRaw(key, JSON.stringify(value));
}

export function removeSlot(key: string): void {
  removeRaw(key);
}

/**
 * Serial operation queue: every mutation re-reads the latest value inside the
 * queue so concurrent callers cannot clobber each other, and a failed
 * operation does not poison later work (extension invariant preserved).
 */
export function createSerialQueue(): <T>(operation: () => Promise<T> | T) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };
}

export interface VersionedRepository<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
  update(mutate: (current: T) => T | Promise<T>): Promise<T>;
}

/**
 * Store-local repository with validation on every read and write. Mirrors
 * core/persistence/versioned-repository.ts: decode is applied to both
 * directions so a corrupt slot never propagates into the prompt pipeline.
 */
export function createRepository<T>(options: {
  key: string;
  createDefault: () => T;
  decode: (value: unknown) => T;
}): VersionedRepository<T> {
  const queue = createSerialQueue();

  const readAlreadyQueued = (): T => {
    const slot = readSlot(options.key);
    if (!slot.present) return options.createDefault();
    return options.decode(slot.value);
  };

  return {
    read() {
      return queue(readAlreadyQueued);
    },
    write(value) {
      return queue(() => {
        readAlreadyQueued();
        writeSlot(options.key, options.decode(value));
      });
    },
    update(mutate) {
      return queue(async () => {
        const current = readAlreadyQueued();
        const next = options.decode(await mutate(current));
        writeSlot(options.key, next);
        return next;
      });
    },
  };
}
