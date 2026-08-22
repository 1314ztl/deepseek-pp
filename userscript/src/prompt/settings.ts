/**
 * Userscript port of core/prompt/settings.ts.
 *
 * These four toggles are the user-facing personalization controls: whether
 * memories are injected, whether the system prompt is injected, how often the
 * active preset is re-injected, and whether the reply language is forced.
 *
 * The storage key matches the extension's so an exported settings blob can be
 * imported on either side.
 */

import { PRESET_REINJECTION_INTERVAL } from '../constants';
import { isSupportedLocale } from '../i18n';
import { createRepository } from '../storage';
import type { SupportedLocale } from '../types';

export type PromptPresetCadence = 'default' | 'first_message' | 'every_message' | 'off';
export type ForcedResponseLanguage = 'auto' | SupportedLocale;

export interface PromptInjectionSettings {
  memoryEnabled: boolean;
  systemPromptEnabled: boolean;
  presetCadence: PromptPresetCadence;
  forceResponseLanguage: ForcedResponseLanguage;
  /** Userscript-only: shows a small toast when memories are injected/saved. */
  showActivityToasts: boolean;
  /** UI + prompt language; 'auto' follows the browser. */
  uiLocale: 'auto' | SupportedLocale;
}

export const DEFAULT_PROMPT_INJECTION_SETTINGS: PromptInjectionSettings = {
  memoryEnabled: true,
  systemPromptEnabled: true,
  presetCadence: 'default',
  forceResponseLanguage: 'auto',
  showActivityToasts: true,
  uiLocale: 'auto',
};

export const PROMPT_SETTINGS_STORAGE_KEY = 'deepseek_pp_prompt_injection_settings';

export function normalizePromptInjectionSettings(value: unknown): PromptInjectionSettings {
  const object =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<PromptInjectionSettings>)
      : {};
  return {
    memoryEnabled: object.memoryEnabled !== false,
    systemPromptEnabled: object.systemPromptEnabled !== false,
    presetCadence: normalizePresetCadence(object.presetCadence),
    forceResponseLanguage: normalizeForcedLanguage(object.forceResponseLanguage),
    showActivityToasts: object.showActivityToasts !== false,
    uiLocale: normalizeUiLocale(object.uiLocale),
  };
}

const repository = createRepository<PromptInjectionSettings>({
  key: PROMPT_SETTINGS_STORAGE_KEY,
  createDefault: () => ({ ...DEFAULT_PROMPT_INJECTION_SETTINGS }),
  decode: normalizePromptInjectionSettings,
});

export function getPromptInjectionSettings(): Promise<PromptInjectionSettings> {
  return repository.read();
}

export function savePromptInjectionSettings(
  settings: Partial<PromptInjectionSettings>,
): Promise<PromptInjectionSettings> {
  return repository.update((current) => ({ ...current, ...settings }));
}

/**
 * Preset cadence policy. 'default' re-injects on the first message and then
 * every PRESET_REINJECTION_INTERVAL messages so long conversations do not
 * drift away from the preset.
 */
export function shouldInjectPresetForTurn(input: {
  hasActivePreset: boolean;
  isFirstMessage: boolean;
  messageCount: number;
  cadence: PromptPresetCadence;
}): boolean {
  if (!input.hasActivePreset) return false;
  switch (input.cadence) {
    case 'off':
      return false;
    case 'first_message':
      return input.isFirstMessage;
    case 'every_message':
      return true;
    case 'default':
    default:
      return input.isFirstMessage || input.messageCount % PRESET_REINJECTION_INTERVAL === 0;
  }
}

function normalizePresetCadence(value: unknown): PromptPresetCadence {
  return value === 'first_message' ||
    value === 'every_message' ||
    value === 'off' ||
    value === 'default'
    ? value
    : DEFAULT_PROMPT_INJECTION_SETTINGS.presetCadence;
}

function normalizeForcedLanguage(value: unknown): ForcedResponseLanguage {
  if (value === 'auto') return 'auto';
  return isSupportedLocale(value)
    ? value
    : DEFAULT_PROMPT_INJECTION_SETTINGS.forceResponseLanguage;
}

function normalizeUiLocale(value: unknown): 'auto' | SupportedLocale {
  if (value === 'auto') return 'auto';
  return isSupportedLocale(value) ? value : DEFAULT_PROMPT_INJECTION_SETTINGS.uiLocale;
}
