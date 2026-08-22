import { describe, expect, it } from 'vitest';
import { extractToolCalls, hasToolCallMarker, stripToolCalls } from '../src/tool/parser';
import { createStreamingToolTextAccumulator } from '../src/tool/streaming-text';
import { createMemoryToolDescriptors, executeMemoryToolCall } from '../src/tool/memory-tools';
import type { Memory, ToolCall } from '../src/types';

const TOOLS = createMemoryToolDescriptors();

describe('extractToolCalls', () => {
  it('extracts a memory_save call', () => {
    const text = `好的。\n\n<memory_save>\n{"type":"user","name":"职业","content":"前端","tags":["前端"]}\n</memory_save>`;
    const calls = extractToolCalls(text, TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('memory_save');
    expect(calls[0].payload).toEqual({
      type: 'user',
      name: '职业',
      content: '前端',
      tags: ['前端'],
    });
  });

  it('extracts multiple calls in one reply', () => {
    const text =
      '<memory_save>{"type":"user","name":"a","content":"a","tags":[]}</memory_save>' +
      'text between' +
      '<memory_delete>{"id":3}</memory_delete>';
    const calls = extractToolCalls(text, TOOLS);
    expect(calls.map((call) => call.name)).toEqual(['memory_save', 'memory_delete']);
  });

  it('reports malformed JSON as a parse error instead of dropping the call', () => {
    const calls = extractToolCalls('<memory_save>{not json}</memory_save>', TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].parseError?.code).toBe('tool_call_json_invalid');
  });

  it('rejects a non-object body', () => {
    const calls = extractToolCalls('<memory_save>[1,2]</memory_save>', TOOLS);
    expect(calls[0].parseError?.code).toBe('tool_call_payload_invalid');
  });

  it('ignores unknown tags', () => {
    expect(extractToolCalls('<not_a_tool>{}</not_a_tool>', TOOLS)).toEqual([]);
  });

  it('ignores an unclosed tag', () => {
    expect(extractToolCalls('<memory_save>{"a":1}', TOOLS)).toEqual([]);
  });

  it('does not hang on adversarial input', () => {
    const started = Date.now();
    extractToolCalls('<'.repeat(50_000) + '>', TOOLS);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('stripToolCalls', () => {
  it('removes the tool block and collapses the blank-line gap', () => {
    const text = 'before\n\n<memory_save>{"a":1}</memory_save>\n\nafter';
    expect(stripToolCalls(text, TOOLS)).toBe('before\n\nafter');
  });

  it('leaves text without tool calls untouched', () => {
    expect(stripToolCalls('just text', TOOLS)).toBe('just text');
  });
});

describe('hasToolCallMarker', () => {
  it('detects an opening tool tag', () => {
    expect(hasToolCallMarker('<memory_save>{}</memory_save>', TOOLS)).toBe(true);
    expect(hasToolCallMarker('no tools here', TOOLS)).toBe(false);
  });
});

describe('streaming accumulator', () => {
  it('suppresses tool XML from the visible text', () => {
    const accumulator = createStreamingToolTextAccumulator(TOOLS);
    accumulator.append('Hello ');
    accumulator.append('<memory_save>{"a":1}</memory_save>');
    accumulator.append('world');
    expect(accumulator.flush()).toBe('Hello world');
  });

  it('handles a tag split across chunks', () => {
    const accumulator = createStreamingToolTextAccumulator(TOOLS);
    accumulator.append('A<mem');
    accumulator.append('ory_save>{"a":1}</memo');
    accumulator.append('ry_save>B');
    expect(accumulator.flush()).toBe('AB');
  });

  it('does not hold back text that merely starts with a less-than sign', () => {
    const accumulator = createStreamingToolTextAccumulator(TOOLS);
    accumulator.append('1 < 2 and 3 > 2');
    expect(accumulator.flush()).toBe('1 < 2 and 3 > 2');
  });

  it('emits an unterminated tool block as suppressed', () => {
    const accumulator = createStreamingToolTextAccumulator(TOOLS);
    accumulator.append('start<memory_save>{"a":');
    expect(accumulator.flush()).toBe('start');
  });
});

describe('executeMemoryToolCall', () => {
  function createCall(name: string, payload: Record<string, unknown>): ToolCall {
    return { id: 'c1', name, invocationName: name, payload, raw: '' };
  }

  function createRuntime() {
    const stored: Memory[] = [];
    let nextId = 1;
    return {
      stored,
      runtime: {
        async saveMemory(input: any) {
          const id = nextId++;
          stored.push({
            id,
            syncId: `s${id}`,
            scope: 'global',
            createdAt: 0,
            updatedAt: 0,
            accessCount: 0,
            lastAccessedAt: 0,
            ...input,
          } as Memory);
          return id;
        },
        async getMemoryById(id: number) {
          return stored.find((memory) => memory.id === id);
        },
        async updateMemory(memory: Memory) {
          const index = stored.findIndex((item) => item.id === memory.id);
          if (index >= 0) stored[index] = memory;
        },
        async deleteMemory(id: number) {
          const index = stored.findIndex((item) => item.id === id);
          if (index >= 0) stored.splice(index, 1);
        },
      },
    };
  }

  it('saves a valid memory', async () => {
    const { stored, runtime } = createRuntime();
    const result = await executeMemoryToolCall(
      createCall('memory_save', {
        type: 'user',
        name: '职业',
        content: '前端',
        tags: ['前端'],
      }),
      'zh-CN',
      runtime,
    );
    expect(result.ok).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('前端');
  });

  it('rejects an invalid memory type', async () => {
    const { runtime } = createRuntime();
    const result = await executeMemoryToolCall(
      createCall('memory_save', { type: 'bogus', name: 'a', content: 'b', tags: [] }),
      'zh-CN',
      runtime,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('memory_invalid_payload');
  });

  it('rejects an empty name', async () => {
    const { runtime } = createRuntime();
    const result = await executeMemoryToolCall(
      createCall('memory_save', { type: 'user', name: '  ', content: 'b', tags: [] }),
      'zh-CN',
      runtime,
    );
    expect(result.ok).toBe(false);
  });

  it('updates an existing memory', async () => {
    const { stored, runtime } = createRuntime();
    await runtime.saveMemory({
      type: 'user',
      name: 'old',
      content: 'old',
      description: '',
      tags: [],
      pinned: false,
    } as never);
    const result = await executeMemoryToolCall(
      createCall('memory_update', {
        id: 1,
        type: 'user',
        name: 'new',
        content: 'new',
        tags: ['t'],
      }),
      'zh-CN',
      runtime,
    );
    expect(result.ok).toBe(true);
    expect(stored[0].name).toBe('new');
  });

  it('reports a missing memory on update', async () => {
    const { runtime } = createRuntime();
    const result = await executeMemoryToolCall(
      createCall('memory_update', { id: 99, type: 'user', name: 'a', content: 'b', tags: [] }),
      'zh-CN',
      runtime,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('memory_not_found');
  });

  it('deletes a memory', async () => {
    const { stored, runtime } = createRuntime();
    await runtime.saveMemory({
      type: 'user',
      name: 'a',
      content: 'b',
      description: '',
      tags: [],
      pinned: false,
    } as never);
    const result = await executeMemoryToolCall(createCall('memory_delete', { id: 1 }), 'zh-CN', runtime);
    expect(result.ok).toBe(true);
    expect(stored).toHaveLength(0);
  });

  it('surfaces a parse error without touching the store', async () => {
    const { stored, runtime } = createRuntime();
    const call = createCall('memory_save', {});
    call.parseError = { code: 'tool_call_json_invalid', message: 'bad', retryable: false };
    const result = await executeMemoryToolCall(call, 'zh-CN', runtime);
    expect(result.ok).toBe(false);
    expect(stored).toHaveLength(0);
  });
});
