/**
 * Userscript port of core/tool/memory.ts.
 *
 * The three memory tools are the write half of the memory loop: the model
 * emits `<memory_save>` / `<memory_update>` / `<memory_delete>` XML, the
 * response parser extracts it, and these executors apply it to IndexedDB.
 *
 * Tool names, schemas and required fields are unchanged from the extension so
 * the same system prompt keeps working.
 */

import type {
  JsonValue,
  MemoryType,
  NewMemory,
  SupportedLocale,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from '../types';
import { translateUi } from '../i18n';
import {
  deleteMemory as deleteMemoryRecord,
  getMemoryById,
  saveMemory as saveMemoryRecord,
  updateMemory as updateMemoryRecord,
} from '../memory/store';

const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'topic', 'reference'];

export const MEMORY_TOOL_NAMES = ['memory_save', 'memory_update', 'memory_delete'] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export function isMemoryToolName(name: string): name is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}

const TYPE_DESCRIPTION =
  'Memory type: user=identity/role/preference, feedback=behavior correction, topic=discussion point, reference=external resource';

export function createMemoryToolDescriptors(): ToolDescriptor[] {
  return [
    {
      id: 'local:memory:memory_save',
      name: 'memory_save',
      invocationName: 'memory_save',
      title: 'Save memory',
      description: 'Save a new long-term memory about the user or the current work.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: MEMORY_TYPES, description: TYPE_DESCRIPTION },
          name: { type: 'string', description: 'Short title' },
          content: { type: 'string', description: 'Content to remember' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tag list used for later retrieval',
          },
        },
        required: ['type', 'name', 'content', 'tags'],
        additionalProperties: false,
      },
    },
    {
      id: 'local:memory:memory_update',
      name: 'memory_update',
      invocationName: 'memory_update',
      title: 'Update memory',
      description: 'Update an existing memory identified by its numeric id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Memory id' },
          type: { type: 'string', enum: MEMORY_TYPES, description: TYPE_DESCRIPTION },
          name: { type: 'string', description: 'Updated title' },
          content: { type: 'string', description: 'Updated content' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tag list',
          },
        },
        required: ['id', 'type', 'name', 'content', 'tags'],
        additionalProperties: false,
      },
    },
    {
      id: 'local:memory:memory_delete',
      name: 'memory_delete',
      invocationName: 'memory_delete',
      title: 'Delete memory',
      description: 'Delete a memory identified by its numeric id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Memory id' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

export interface MemoryToolRuntime {
  saveMemory(input: NewMemory): Promise<number>;
  getMemoryById(id: number): Promise<import('../types').Memory | undefined>;
  updateMemory(memory: import('../types').Memory): Promise<void>;
  deleteMemory(id: number): Promise<void>;
}

export const defaultMemoryToolRuntime: MemoryToolRuntime = {
  saveMemory: saveMemoryRecord,
  getMemoryById,
  updateMemory: updateMemoryRecord,
  deleteMemory: deleteMemoryRecord,
};

export async function executeMemoryToolCall(
  call: ToolCall,
  locale: SupportedLocale,
  runtime: MemoryToolRuntime = defaultMemoryToolRuntime,
): Promise<ToolResult> {
  if (call.parseError) {
    return failure(call, call.parseError.code, 'Tool call format error', call.parseError.message, false);
  }
  if (call.name === 'memory_save') return saveMemory(runtime, call, locale);
  if (call.name === 'memory_update') return updateExistingMemory(runtime, call, locale);
  if (call.name === 'memory_delete') return deleteExistingMemory(runtime, call, locale);

  return failure(
    call,
    'memory_tool_unsupported',
    'Unsupported memory tool',
    `Unsupported memory tool: ${call.name}`,
    false,
  );
}

async function saveMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const parsed = parseMemorySavePayload(call);
  if (!parsed.ok) return parsed.result;

  const id = await runtime.saveMemory({
    type: parsed.memory.type,
    name: parsed.memory.name,
    content: parsed.memory.content,
    description: parsed.memory.name,
    tags: parsed.memory.tags,
    pinned: false,
  });

  if (!id) {
    return failure(
      call,
      'memory_save_failed',
      'Memory save failed',
      'The memory store did not return a record id.',
      true,
    );
  }

  return success(
    call,
    translateUi(locale, 'memorySaved', { name: parsed.memory.name }),
    parsed.memory.name,
    { id },
  );
}

function parseMemorySavePayload(
  call: ToolCall,
):
  | { ok: true; memory: Pick<NewMemory, 'type' | 'name' | 'content' | 'tags'> }
  | { ok: false; result: ToolResult } {
  const payload = call.payload;
  const type = memoryTypeValue(payload.type);
  if (!type) {
    return {
      ok: false,
      result: failure(call, 'memory_invalid_payload', 'Invalid payload', 'type is invalid', false),
    };
  }

  const name = requiredStringValue(payload.name);
  if (!name) {
    return {
      ok: false,
      result: failure(call, 'memory_invalid_payload', 'Invalid payload', 'name is invalid', false),
    };
  }

  const content = requiredStringValue(payload.content);
  if (!content) {
    return {
      ok: false,
      result: failure(call, 'memory_invalid_payload', 'Invalid payload', 'content is invalid', false),
    };
  }

  if (!Array.isArray(payload.tags) || !payload.tags.every((item) => typeof item === 'string')) {
    return {
      ok: false,
      result: failure(call, 'memory_invalid_payload', 'Invalid payload', 'tags is invalid', false),
    };
  }

  return { ok: true, memory: { type, name, content, tags: [...(payload.tags as string[])] } };
}

async function updateExistingMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const payload = call.payload;
  const id = numberValue(payload.id);
  if (!id) return failure(call, 'memory_invalid_id', 'Invalid memory id', undefined, false);

  const existing = await runtime.getMemoryById(id);
  if (!existing) {
    return failure(
      call,
      'memory_not_found',
      'Memory not found',
      `Memory #${id} does not exist.`,
      false,
    );
  }

  const name = stringValue(payload.name) || existing.name;
  await runtime.updateMemory({
    ...existing,
    type: memoryTypeValue(payload.type) || existing.type,
    name,
    content: stringValue(payload.content) || existing.content,
    description: name || existing.description,
    tags: Array.isArray(payload.tags) ? stringArrayValue(payload.tags) : existing.tags,
  });

  return success(call, translateUi(locale, 'memoryUpdated', { name }), name);
}

async function deleteExistingMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const id = numberValue(call.payload.id);
  if (!id) return failure(call, 'memory_invalid_id', 'Invalid memory id', undefined, false);

  await runtime.deleteMemory(id);
  return success(call, translateUi(locale, 'memoryDeleted', { name: `#${id}` }), `#${id}`);
}

function success(
  call: ToolCall,
  summary: string,
  detail?: string,
  output?: JsonValue,
): ToolResult {
  return {
    ok: true,
    name: call.name,
    callId: call.id,
    descriptorId: call.descriptorId,
    summary,
    detail,
    output,
  };
}

function failure(
  call: ToolCall,
  code: string,
  summary: string,
  detail: string | undefined,
  retryable: boolean,
): ToolResult {
  return {
    ok: false,
    name: call.name,
    callId: call.id,
    descriptorId: call.descriptorId,
    summary,
    detail,
    error: { code, message: detail ?? summary, retryable },
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requiredStringValue(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function memoryTypeValue(value: unknown): MemoryType | null {
  return typeof value === 'string' && MEMORY_TYPES.includes(value as MemoryType)
    ? (value as MemoryType)
    : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
