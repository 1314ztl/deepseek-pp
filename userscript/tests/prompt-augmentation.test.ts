import { describe, expect, it } from 'vitest';
import type { Memory } from '../src/types';
import { buildPromptAugmentation } from '../src/prompt/augmentation';
import {
  VISIBLE_USER_PROMPT_END,
  VISIBLE_USER_PROMPT_START,
  containsInternalPromptMarker,
  extractVisibleUserPrompt,
  markVisibleUserPrompt,
  sanitizeInternalPromptText,
} from '../src/prompt/visibility';
import {
  DEFAULT_PROMPT_INJECTION_SETTINGS,
  normalizePromptInjectionSettings,
  shouldInjectPresetForTurn,
} from '../src/prompt/settings';
import { createMemoryToolDescriptors } from '../src/tool/memory-tools';

const TOOLS = createMemoryToolDescriptors();

function createMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: 1,
    syncId: 'sync-1',
    scope: 'global',
    type: 'user',
    name: '用户职业',
    content: '前端开发',
    description: '',
    tags: ['前端'],
    pinned: false,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

describe('buildPromptAugmentation', () => {
  it('wraps the user prompt in visibility markers', () => {
    const { augmented } = buildPromptAugmentation('你好', { toolDescriptors: TOOLS });
    expect(augmented).toContain(VISIBLE_USER_PROMPT_START);
    expect(augmented).toContain(VISIBLE_USER_PROMPT_END);
    expect(extractVisibleUserPrompt(augmented)).toBe('你好');
  });

  it('injects matching memories and reports their ids', () => {
    const memory = createMemory({ id: 42 });
    const { augmented, usedMemoryIds } = buildPromptAugmentation('我的前端项目', {
      memories: [memory],
      toolDescriptors: TOOLS,
    });
    expect(augmented).toContain('前端开发');
    expect(usedMemoryIds).toEqual([42]);
  });

  it('omits memories and reports none when memory injection is disabled', () => {
    // A distinctive value: the system prompt template itself contains a worked
    // example mentioning "前端开发", so a generic string would false-positive.
    const { augmented, usedMemoryIds } = buildPromptAugmentation('我的前端项目', {
      memories: [createMemory({ content: 'ZZUNIQUEMEMORYZZ' })],
      memoryEnabled: false,
      toolDescriptors: TOOLS,
    });
    expect(augmented).toContain('(本次请求已关闭记忆注入)');
    expect(augmented).not.toContain('ZZUNIQUEMEMORYZZ');
    expect(usedMemoryIds).toEqual([]);
  });

  it('renders the tool schemas so the model can emit memory_save', () => {
    const { augmented, renderedToolCount } = buildPromptAugmentation('hi', {
      toolDescriptors: TOOLS,
    });
    expect(augmented).toContain('### Tool memory_save');
    expect(augmented).toContain('### Tool memory_update');
    expect(augmented).toContain('### Tool memory_delete');
    expect(renderedToolCount).toBe(3);
  });

  it('still injects memories standalone when the system prompt is disabled', () => {
    const { augmented } = buildPromptAugmentation('hi', {
      memories: [createMemory()],
      systemPromptEnabled: false,
      toolDescriptors: TOOLS,
    });
    expect(augmented).toContain('## 已有记忆');
    expect(augmented).toContain('前端开发');
    // No tool schema section when the system prompt is off.
    expect(augmented).not.toContain('### Tool memory_save');
  });

  it('prefixes the preset content before the system block', () => {
    const { augmented } = buildPromptAugmentation('hi', {
      presetContent: 'ACT AS A PIRATE',
      toolDescriptors: TOOLS,
    });
    expect(augmented.indexOf('ACT AS A PIRATE')).toBe(0);
    expect(augmented).toContain('ACT AS A PIRATE\n\n---\n\n');
  });

  it('includes project context when provided', () => {
    const { augmented } = buildPromptAugmentation('hi', {
      projectContext: 'Repo uses pnpm',
      toolDescriptors: TOOLS,
    });
    expect(augmented).toContain('## 项目上下文');
    expect(augmented).toContain('Repo uses pnpm');
  });

  it('adds a forced response language section', () => {
    const { augmented } = buildPromptAugmentation('hi', {
      forceResponseLanguage: 'en',
      locale: 'zh-CN',
      toolDescriptors: TOOLS,
    });
    expect(augmented).toContain('## 回复语言');
    expect(augmented).toContain('英文');
  });

  it('uses the thinking template when thinking is enabled', () => {
    const { augmented } = buildPromptAugmentation('hi', {
      thinkingEnabled: true,
      toolDescriptors: TOOLS,
    });
    expect(augmented).toContain('你具有长期记忆能力');
  });

  it('keeps the real user text visible when a skill body replaces the prompt', () => {
    const { augmented } = buildPromptAugmentation('SKILL INSTRUCTIONS', {
      visibleUserPrompt: '/translate hello',
      toolDescriptors: TOOLS,
    });
    expect(augmented).toContain('SKILL INSTRUCTIONS');
    // The metadata marker carries the literal user input for the UI.
    expect(extractVisibleUserPrompt(augmented)).toBe('/translate hello');
  });
});

describe('visibility helpers', () => {
  it('round-trips a marked prompt', () => {
    expect(extractVisibleUserPrompt(markVisibleUserPrompt('hello'))).toBe('hello');
  });

  it('returns null for unmarked text', () => {
    expect(extractVisibleUserPrompt('plain text')).toBeNull();
  });

  it('reduces an augmented prompt down to the user text', () => {
    const { augmented } = buildPromptAugmentation('原始问题', { toolDescriptors: TOOLS });
    expect(sanitizeInternalPromptText(augmented)).toBe('原始问题');
  });

  it('detects internal markers', () => {
    const { augmented } = buildPromptAugmentation('q', { toolDescriptors: TOOLS });
    expect(containsInternalPromptMarker(augmented)).toBe(true);
    expect(containsInternalPromptMarker('normal message')).toBe(false);
  });
});

describe('shouldInjectPresetForTurn', () => {
  const base = { hasActivePreset: true, isFirstMessage: false, messageCount: 3 };

  it('never injects without an active preset', () => {
    expect(
      shouldInjectPresetForTurn({ ...base, hasActivePreset: false, cadence: 'every_message' }),
    ).toBe(false);
  });

  it('respects the off cadence', () => {
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'off' })).toBe(false);
  });

  it('injects on every message for every_message', () => {
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'every_message' })).toBe(true);
  });

  it('injects only on the first message for first_message', () => {
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'first_message' })).toBe(false);
    expect(
      shouldInjectPresetForTurn({ ...base, isFirstMessage: true, cadence: 'first_message' }),
    ).toBe(true);
  });

  it('injects on the first message and every 10th for default', () => {
    expect(shouldInjectPresetForTurn({ ...base, isFirstMessage: true, cadence: 'default' })).toBe(true);
    expect(shouldInjectPresetForTurn({ ...base, messageCount: 10, cadence: 'default' })).toBe(true);
    expect(shouldInjectPresetForTurn({ ...base, messageCount: 11, cadence: 'default' })).toBe(false);
  });
});

describe('normalizePromptInjectionSettings', () => {
  it('falls back to defaults for junk input', () => {
    expect(normalizePromptInjectionSettings(null)).toEqual(DEFAULT_PROMPT_INJECTION_SETTINGS);
    expect(normalizePromptInjectionSettings('nope')).toEqual(DEFAULT_PROMPT_INJECTION_SETTINGS);
  });

  it('treats only explicit false as disabled', () => {
    expect(normalizePromptInjectionSettings({ memoryEnabled: false }).memoryEnabled).toBe(false);
    expect(normalizePromptInjectionSettings({ memoryEnabled: undefined }).memoryEnabled).toBe(true);
  });

  it('rejects unknown cadence and language values', () => {
    const settings = normalizePromptInjectionSettings({
      presetCadence: 'weekly',
      forceResponseLanguage: 'fr',
    });
    expect(settings.presetCadence).toBe('default');
    expect(settings.forceResponseLanguage).toBe('auto');
  });
});
