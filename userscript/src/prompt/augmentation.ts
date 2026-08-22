/**
 * Userscript port of core/prompt/augmentation.ts.
 *
 * Assembles the final prompt sent to DeepSeek:
 *
 *   [preset]\n\n---\n\n[system: role + memories + tools + project + language]
 *   \n\n[visible-prompt metadata]\n[marked user prompt][tool reminder]
 *
 * The ordering, separators and marker placement are preserved from the
 * extension because the response filter and history cleaner locate the user's
 * real text by exactly these boundaries.
 */

import type { Memory, SupportedLocale, ToolDescriptor } from '../types';
import { translate } from '../i18n';
import {
  estimateTokens,
  formatMemoriesBlock,
  getMemoryBudget,
  selectMemories,
} from '../memory/selector';
import { markVisibleUserPrompt, markVisibleUserPromptMetadata } from './visibility';
import { createToolInvocationCatalog } from '../tool/parser';

export interface PromptAugmentationOptions {
  memories?: readonly Memory[];
  thinkingEnabled?: boolean;
  /** Restricts memory candidates to identity-defining records. */
  identityOnly?: boolean;
  /** The real user text, when the prompt body is a Skill/expanded instruction. */
  visibleUserPrompt?: string;
  presetContent?: string | null;
  projectContext?: string | null;
  toolDescriptors?: readonly ToolDescriptor[];
  locale?: SupportedLocale;
  memoryEnabled?: boolean;
  systemPromptEnabled?: boolean;
  forceResponseLanguage?: SupportedLocale | null;
}

export interface PromptAugmentationResult {
  augmented: string;
  usedMemoryIds: number[];
  renderedToolCount: number;
}

export function buildPromptAugmentation(
  originalPrompt: string,
  options?: PromptAugmentationOptions,
): PromptAugmentationResult {
  const {
    memories = [],
    thinkingEnabled = false,
    identityOnly = false,
    presetContent = null,
    projectContext = null,
    locale = 'zh-CN',
    memoryEnabled = true,
    systemPromptEnabled = true,
    forceResponseLanguage = null,
  } = options ?? {};
  const toolDescriptors = options?.toolDescriptors ?? [];
  const visiblePromptMetadata =
    options?.visibleUserPrompt === undefined
      ? ''
      : `${markVisibleUserPromptMetadata(options.visibleUserPrompt)}\n`;

  const promptTokens = estimateTokens(originalPrompt);
  const budget = getMemoryBudget(promptTokens);
  const selected = memoryEnabled
    ? selectMemories(originalPrompt, memories, { budget, identityOnly })
    : [];
  const memBlock = memoryEnabled
    ? formatMemoriesBlock(selected, locale)
    : translate(locale, 'memoryDisabled');
  const toolsBlock = systemPromptEnabled ? renderToolSchemas(toolDescriptors) : '';
  const baseSystem = systemPromptEnabled
    ? translate(locale, thinkingEnabled ? 'systemThinking' : 'systemChat', {
        memories: memBlock,
        tools: toolsBlock,
      })
    : '';
  const standaloneMemories =
    !systemPromptEnabled && memoryEnabled
      ? translate(locale, 'standaloneMemories', { memories: memBlock })
      : '';
  const system = [
    baseSystem,
    standaloneMemories,
    renderProjectContext(projectContext, locale),
    renderForcedResponseLanguage(forceResponseLanguage, locale),
  ]
    .filter(Boolean)
    .join('\n\n');
  const presetPrefix = presetContent ? `${presetContent}\n\n---\n\n` : '';
  const toolReminder = systemPromptEnabled ? renderToolFormatReminder(toolDescriptors, locale) : '';
  const systemPrefix = system ? `${system}\n\n` : '';

  return {
    augmented:
      presetPrefix +
      systemPrefix +
      visiblePromptMetadata +
      markVisibleUserPrompt(originalPrompt) +
      toolReminder,
    usedMemoryIds: selected
      .map((memory) => memory.id)
      .filter((id): id is number => typeof id === 'number'),
    renderedToolCount: systemPromptEnabled ? toolDescriptors.length : 0,
  };
}

function renderProjectContext(
  projectContext: string | null | undefined,
  locale: SupportedLocale,
): string {
  const trimmed = typeof projectContext === 'string' ? projectContext.trim() : '';
  if (!trimmed) return '';
  return `${translate(locale, 'projectContextHeader')}\n${trimmed}`;
}

function renderForcedResponseLanguage(
  forceResponseLanguage: SupportedLocale | null,
  locale: SupportedLocale,
): string {
  if (!forceResponseLanguage) return '';
  const language =
    forceResponseLanguage === 'en'
      ? translate(locale, 'responseLanguageEnglish')
      : translate(locale, 'responseLanguageChinese');
  return translate(locale, 'forceResponseLanguage', { language });
}

export function renderToolSchemas(descriptors: readonly ToolDescriptor[]): string {
  return descriptors.map((descriptor) => renderToolSchema(descriptor)).join('\n\n');
}

function renderToolSchema(descriptor: ToolDescriptor): string {
  const examplePayload = createExamplePayload(descriptor);
  const name = descriptor.invocationName;
  return [
    `### Tool ${name}`,
    `Title: ${descriptor.title}`,
    `Description: ${descriptor.description}`,
    `Valid call format for ${name}:`,
    `<${name}>`,
    JSON.stringify(examplePayload, null, 2),
    `</${name}>`,
    `Invalid formats: <invoke name="${name}">...</invoke>, <tool_call>...</tool_call>`,
    `Parameters JSON Schema: ${JSON.stringify(descriptor.inputSchema)}`,
  ].join('\n');
}

export function renderToolFormatReminder(
  descriptors: readonly ToolDescriptor[],
  locale: SupportedLocale,
): string {
  const catalog = createToolInvocationCatalog(descriptors);
  const names = catalog.invocationNames;
  if (names.length === 0) return '';
  return `\n\n${translate(locale, 'toolFormatReminder', { names: names.join(', ') })}`;
}

function createExamplePayload(descriptor: ToolDescriptor): Record<string, unknown> {
  const properties = descriptor.inputSchema.properties ?? {};
  const required = descriptor.inputSchema.required ?? Object.keys(properties);
  const payload: Record<string, unknown> = {};
  for (const key of required) {
    payload[key] = exampleValue(properties[key]);
  }
  return payload;
}

function exampleValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return 'value';
  const value = schema as Record<string, unknown>;
  const type = value.type;
  if (Array.isArray(type)) return exampleValue({ ...value, type: type[0] });
  if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0];
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'string':
    default:
      return 'value';
  }
}
