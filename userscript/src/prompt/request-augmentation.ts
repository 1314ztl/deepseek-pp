/**
 * Userscript port of core/interceptor/request-augmentation.ts.
 *
 * Given a decoded DeepSeek request body, this resolves the current
 * personalization state (memories, active preset, project context, prompt
 * settings) and rewrites `body.prompt` into the augmented prompt.
 *
 * The Skill subsystem of the extension is reduced here to the `/name args`
 * expansion over user-defined prompt snippets; MCP, shell, browser control and
 * the agent loop are intentionally out of scope for the userscript.
 */

import type { Memory, SupportedLocale, SystemPromptPreset, ToolDescriptor } from '../types';
import { SKILL_TRIGGER_REGEX } from '../constants';
import { translate } from '../i18n';
import { filterMemoriesByProjectScope } from '../memory/scope';
import { buildPromptAugmentation } from './augmentation';
import {
  DEFAULT_PROMPT_INJECTION_SETTINGS,
  normalizePromptInjectionSettings,
  shouldInjectPresetForTurn,
  type PromptInjectionSettings,
} from './settings';
import type { DeepSeekRequestBody } from '../deepseek/routes';

export interface SkillSnippet {
  name: string;
  instructions: string;
  /** false restricts memory injection to identity memories for this turn. */
  memoryEnabled: boolean;
}

export interface RequestAugmentationState {
  memories: readonly Memory[];
  skills: readonly SkillSnippet[];
  activePreset: SystemPromptPreset | null;
  projectContext?: string | null;
  projectId?: string | null;
  toolDescriptors: readonly ToolDescriptor[];
  messageCount: number;
  locale: SupportedLocale;
  promptSettings?: Partial<PromptInjectionSettings>;
}

export interface RequestAugmentationResult {
  body: string;
  /** The user's real input, for the response filter and history cleanup. */
  originalPrompt: string;
  usedMemoryIds: number[];
  messageCount: number;
}

export function augmentDecodedRequestBody(
  decodedBody: Readonly<DeepSeekRequestBody>,
  state: RequestAugmentationState,
): RequestAugmentationResult {
  const body: DeepSeekRequestBody = { ...decodedBody };
  const originalPrompt = body.prompt;
  const locale = state.locale;

  const thinkingEnabled = body.thinking_enabled === true;
  const isFirstMessage =
    body.parent_message_id === null || body.parent_message_id === undefined;
  const messageCount = isFirstMessage ? 1 : state.messageCount + 1;
  const promptSettings = normalizePromptInjectionSettings(
    state.promptSettings ?? DEFAULT_PROMPT_INJECTION_SETTINGS,
  );

  const shouldInjectPreset = shouldInjectPresetForTurn({
    hasActivePreset: Boolean(state.activePreset),
    isFirstMessage,
    messageCount,
    cadence: promptSettings.presetCadence,
  });
  const presetContent = shouldInjectPreset ? state.activePreset!.content : null;
  const forceResponseLanguage =
    promptSettings.forceResponseLanguage === 'auto'
      ? null
      : promptSettings.forceResponseLanguage;

  const scopedMemories = filterMemoriesByProjectScope(state.memories, state.projectId);
  const resolvedSkill = resolveSkill(state.skills, originalPrompt, locale);

  if (resolvedSkill) {
    // A Skill invocation replaces the prompt body with the Skill instructions,
    // while the user's literal `/name args` text stays the visible prompt.
    const { augmented, usedMemoryIds } = buildPromptAugmentation(resolvedSkill.combinedPrompt, {
      memories: scopedMemories,
      thinkingEnabled,
      identityOnly: !resolvedSkill.memoryEnabled,
      visibleUserPrompt: originalPrompt,
      presetContent,
      projectContext: state.projectContext,
      toolDescriptors: state.toolDescriptors,
      locale,
      memoryEnabled: promptSettings.memoryEnabled,
      systemPromptEnabled: promptSettings.systemPromptEnabled,
      forceResponseLanguage,
    });
    body.prompt = augmented;
    return {
      body: JSON.stringify(body),
      originalPrompt,
      usedMemoryIds,
      messageCount,
    };
  }

  const { augmented, usedMemoryIds } = buildPromptAugmentation(originalPrompt, {
    memories: scopedMemories,
    thinkingEnabled,
    presetContent,
    projectContext: state.projectContext,
    toolDescriptors: state.toolDescriptors,
    locale,
    memoryEnabled: promptSettings.memoryEnabled,
    systemPromptEnabled: promptSettings.systemPromptEnabled,
    forceResponseLanguage,
  });
  body.prompt = augmented;

  return {
    body: JSON.stringify(body),
    originalPrompt,
    usedMemoryIds,
    messageCount,
  };
}

interface ResolvedSkill {
  combinedPrompt: string;
  memoryEnabled: boolean;
  skillName: string;
}

export interface SkillInvocation {
  skillName: string;
  args: string;
}

export function parseSkillCommand(input: string): SkillInvocation | null {
  const match = input.match(SKILL_TRIGGER_REGEX);
  if (!match) return null;
  return { skillName: match[1], args: match[2]?.trim() ?? '' };
}

function resolveSkill(
  skills: readonly SkillSnippet[],
  prompt: string,
  locale: SupportedLocale,
): ResolvedSkill | null {
  const invocation = parseSkillCommand(prompt);
  if (!invocation) return null;
  const skill = skills.find((item) => item.name === invocation.skillName);
  if (!skill) return null;

  return {
    combinedPrompt: invocation.args
      ? translate(locale, 'skillUserInputWrapper', {
          instructions: skill.instructions,
          userInput: invocation.args,
        })
      : skill.instructions,
    memoryEnabled: skill.memoryEnabled,
    skillName: skill.name,
  };
}
