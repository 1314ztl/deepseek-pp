import { describe, expect, it } from 'vitest';
import type { Memory } from '../src/types';
import {
  estimateTokens,
  formatMemoriesBlock,
  formatMemoryLine,
  getMemoryBudget,
  segmentText,
  selectMemories,
} from '../src/memory/selector';
import { MEMORY_TOKEN_BUDGET } from '../src/constants';

function createMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: 1,
    syncId: 'sync-1',
    scope: 'global',
    type: 'user',
    name: 'name',
    content: 'content',
    description: '',
    tags: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

describe('estimateTokens', () => {
  it('weights CJK characters more heavily than ASCII', () => {
    expect(estimateTokens('abcd')).toBe(2); // 4 * 0.3 = 1.2 -> ceil 2
    expect(estimateTokens('中文中文')).toBe(3); // 4 * 0.6 = 2.4 -> ceil 3
  });

  it('returns zero for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('getMemoryBudget', () => {
  it('uses the full budget for short prompts', () => {
    expect(getMemoryBudget(100)).toBe(MEMORY_TOKEN_BUDGET);
    expect(getMemoryBudget(3000)).toBe(MEMORY_TOKEN_BUDGET);
  });

  it('shrinks the budget for long prompts but never below 800', () => {
    expect(getMemoryBudget(4000)).toBe(MEMORY_TOKEN_BUDGET - 200);
    expect(getMemoryBudget(100_000)).toBe(800);
  });
});

describe('segmentText', () => {
  it('drops stop words and single characters', () => {
    const words = segmentText('the quick brown fox');
    expect(words).not.toContain('the');
    expect(words).toContain('quick');
  });
});

describe('selectMemories', () => {
  it('returns nothing when there are no memories', () => {
    expect(selectMemories('hello', [])).toEqual([]);
  });

  it('ranks pinned memories first regardless of relevance', () => {
    const pinned = createMemory({ id: 1, name: 'unrelated', content: 'unrelated', pinned: true });
    const relevant = createMemory({
      id: 2,
      name: 'typescript',
      content: 'uses typescript',
      tags: ['typescript'],
    });
    const selected = selectMemories('typescript question', [relevant, pinned]);
    expect(selected[0].id).toBe(1);
  });

  it('ranks tag matches above content matches', () => {
    const tagged = createMemory({ id: 1, name: 'a', content: 'a', tags: ['react'] });
    const contentOnly = createMemory({ id: 2, name: 'b', content: 'react appears here' });
    const selected = selectMemories('react question', [contentOnly, tagged]);
    expect(selected[0].id).toBe(1);
  });

  it('restricts candidates to identity memories when identityOnly is set', () => {
    const topic = createMemory({ id: 1, type: 'topic' });
    const user = createMemory({ id: 2, type: 'user' });
    const feedback = createMemory({ id: 3, type: 'feedback' });
    const pinnedTopic = createMemory({ id: 4, type: 'topic', pinned: true });

    const selected = selectMemories('anything', [topic, user, feedback, pinnedTopic], {
      identityOnly: true,
    });
    const ids = selected.map((memory) => memory.id).sort();
    expect(ids).toEqual([2, 3, 4]);
  });

  it('stops once the token budget is exhausted but always returns at least one', () => {
    const long = 'x'.repeat(4000);
    const memories = [
      createMemory({ id: 1, content: long }),
      createMemory({ id: 2, content: long }),
      createMemory({ id: 3, content: long }),
    ];
    const selected = selectMemories('query', memories, { budget: 10 });
    expect(selected).toHaveLength(1);
  });
});

describe('formatMemoryLine', () => {
  it('includes the id, type and content', () => {
    const line = formatMemoryLine(createMemory({ id: 7, type: 'feedback', name: 'N', content: 'C' }));
    expect(line).toBe('- #7 [feedback] N: C');
  });

  it('marks project scope', () => {
    const line = formatMemoryLine(
      createMemory({ id: 8, scope: 'project', projectId: 'p1', name: 'N', content: 'C' }),
    );
    expect(line).toBe('- #8 [project user] N: C');
  });

  it('neutralizes the DSML delimiter so it cannot break the request encoding', () => {
    const line = formatMemoryLine(createMemory({ content: 'a｜DSML｜b' }));
    expect(line).toContain('|DSML|');
    expect(line).not.toContain('｜DSML｜');
  });
});

describe('formatMemoriesBlock', () => {
  it('renders a placeholder when empty', () => {
    expect(formatMemoriesBlock([], 'zh-CN')).toBe('(暂无记忆)');
    expect(formatMemoriesBlock([], 'en')).toBe('(No memories yet)');
  });

  it('joins lines with newlines', () => {
    const block = formatMemoriesBlock([
      createMemory({ id: 1, name: 'A', content: 'a' }),
      createMemory({ id: 2, name: 'B', content: 'b' }),
    ]);
    expect(block.split('\n')).toHaveLength(2);
  });
});
