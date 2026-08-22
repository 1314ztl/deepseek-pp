/**
 * Userscript port of core/memory/store.ts.
 *
 * The extension used a dexie-compatible wrapper over IndexedDB; a userscript
 * cannot ship dexie without bloating the bundle, so this is a minimal raw
 * IndexedDB implementation with the same guarantees:
 *
 *  - every read validates each record through the codec;
 *  - every mutation happens inside one transaction after a validating read;
 *  - all mutations are serialized through a store-local queue (the userscript
 *    equivalent of the extension's local-state lock);
 *  - syncId is the dedup key on import, so re-importing an export updates
 *    rows instead of duplicating them.
 *
 * The database is namespaced separately from the extension's `DeepSeekPP`
 * database because the userscript lives on the page origin, where DeepSeek's
 * own databases also live. Interchange with the extension happens through the
 * JSON export/import format, which is byte-compatible.
 */

import type { Memory, NewMemory } from '../types';
import { MIN_ACCESS_FOR_RETENTION, STALE_THRESHOLD_DAYS } from '../constants';
import { createSerialQueue } from '../storage';
import { decodeImportedMemory, decodePersistedMemoryRecord } from './codec';

export const MEMORY_DATABASE_NAME = 'DeepSeekPPUserscript';
export const MEMORY_DATABASE_VERSION = 1;
export const MEMORY_TABLE_NAME = 'memories';

const queue = createSerialQueue();
let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(MEMORY_DATABASE_NAME, MEMORY_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEMORY_TABLE_NAME)) {
        const store = db.createObjectStore(MEMORY_TABLE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });
        // Indexes mirror the extension's v3 schema so query shapes stay valid.
        store.createIndex('syncId', 'syncId', { unique: false });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('pinned', 'pinned', { unique: false });
        store.createIndex('scope', 'scope', { unique: false });
        store.createIndex('projectId', 'projectId', { unique: false });
        store.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
  return databasePromise;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(MEMORY_TABLE_NAME, mode);
    const store = transaction.objectStore(MEMORY_TABLE_NAME);
    let result: T;
    let settled = false;
    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
      }
    };
    operation(store).then(
      (value) => {
        result = value;
      },
      (error) => {
        settled = true;
        reject(error);
        try {
          transaction.abort();
        } catch {
          /* transaction already finished */
        }
      },
    );
  });
}

/** Reads and validates every stored record. */
async function readValidated(store: IDBObjectStore): Promise<Memory[]> {
  const records = (await promisifyRequest(store.getAll())) as unknown[];
  return records.map((record, index) => decodePersistedMemoryRecord(record, `memories[${index}]`));
}

export async function getAllMemories(): Promise<Memory[]> {
  return withStore('readonly', readValidated);
}

export async function getMemoryById(id: number): Promise<Memory | undefined> {
  const all = await getAllMemories();
  return all.find((memory) => memory.id === id);
}

export async function saveMemory(memory: NewMemory): Promise<number> {
  const [id] = await importMemoriesAtomically([memory]);
  if (id === undefined) throw new Error('Memory save did not create a record');
  return id;
}

/**
 * Imports a batch atomically, deduplicating by syncId both against existing
 * rows and within the batch itself (duplicate syncIds break export/import
 * matching, so a repeated syncId merges into one row).
 */
export async function importMemoriesAtomically(
  memoriesToImport: readonly NewMemory[],
): Promise<number[]> {
  const validated = memoriesToImport.map((memory, index) =>
    decodeImportedMemory(memory, `memories[${index}]`),
  );

  return queue(() =>
    withStore('readwrite', async (store) => {
      const current = await readValidated(store);
      const now = Date.now();
      const ids: number[] = [];
      const batchRows = new Map<string, Memory>();

      for (const memory of validated) {
        const syncId = memory.syncId ?? createSyncId();
        const existing = memory.syncId
          ? current.find((record) => record.syncId === memory.syncId)
          : undefined;

        if (existing?.id !== undefined) {
          const merged: Memory = { ...existing, ...memory, id: existing.id, syncId, updatedAt: now };
          await promisifyRequest(store.put(stripUndefined(merged)));
          ids.push(existing.id);
          continue;
        }

        if (memory.syncId) {
          const batchRow = batchRows.get(memory.syncId);
          if (batchRow?.id !== undefined) {
            const merged: Memory = {
              ...batchRow,
              ...memory,
              id: batchRow.id,
              syncId,
              updatedAt: now,
            };
            await promisifyRequest(store.put(stripUndefined(merged)));
            batchRows.set(memory.syncId, merged);
            ids.push(batchRow.id);
            continue;
          }
        }

        const record = {
          ...memory,
          syncId,
          createdAt: now,
          updatedAt: now,
          accessCount: 0,
          lastAccessedAt: now,
        } as Memory;
        const key = await promisifyRequest(store.add(stripUndefined(record)));
        const numericId = key as number;
        if (memory.syncId) batchRows.set(memory.syncId, { ...record, id: numericId });
        ids.push(numericId);
      }

      return ids;
    }),
  );
}

export async function updateMemory(memory: Memory): Promise<void> {
  const validated = decodePersistedMemoryRecord(memory);
  await queue(() =>
    withStore('readwrite', async (store) => {
      await readValidated(store);
      await promisifyRequest(
        store.put(stripUndefined({ ...validated, updatedAt: Date.now() })),
      );
    }),
  );
}

export async function deleteMemory(id: number): Promise<void> {
  await queue(() =>
    withStore('readwrite', async (store) => {
      await readValidated(store);
      await promisifyRequest(store.delete(id));
    }),
  );
}

/** Bumps accessCount/lastAccessedAt for the memories injected into a prompt. */
export async function touchMemories(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await queue(() =>
    withStore('readwrite', async (store) => {
      const current = await readValidated(store);
      const targetIds = new Set(ids);
      const now = Date.now();
      for (const memory of current) {
        if (memory.id === undefined || !targetIds.has(memory.id)) continue;
        await promisifyRequest(
          store.put(
            stripUndefined({
              ...memory,
              accessCount: memory.accessCount + 1,
              lastAccessedAt: now,
            }),
          ),
        );
      }
    }),
  );
}

export async function replaceAllMemories(memories: readonly Memory[]): Promise<void> {
  const validated = memories.map((memory, index) =>
    decodePersistedMemoryRecord(memory, `memories[${index}]`),
  );
  await queue(() =>
    withStore('readwrite', async (store) => {
      await readValidated(store);
      await promisifyRequest(store.clear());
      for (const memory of validated) {
        await promisifyRequest(store.add(stripUndefined(memory)));
      }
    }),
  );
}

/** Drops memories that are old, unpinned and rarely used. */
export async function archiveStaleMemories(): Promise<number> {
  return queue(() =>
    withStore('readwrite', async (store) => {
      const threshold = Date.now() - STALE_THRESHOLD_DAYS * 86_400_000;
      const current = await readValidated(store);
      const ids = current
        .filter(
          (memory) =>
            memory.lastAccessedAt < threshold &&
            !memory.pinned &&
            memory.accessCount < MIN_ACCESS_FOR_RETENTION,
        )
        .map((memory) => memory.id)
        .filter((id): id is number => id !== undefined);

      for (const id of ids) {
        await promisifyRequest(store.delete(id));
      }
      return ids.length;
    }),
  );
}

export function createSyncId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for pages where crypto.randomUUID is unavailable.
  const random = Math.random().toString(16).slice(2);
  return `${Date.now().toString(16)}-${random}`;
}

/** IndexedDB rejects `undefined` optional keys on indexed paths. */
function stripUndefined<T extends object>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result as T;
}
