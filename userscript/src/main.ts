/**
 * Userscript entry point.
 *
 * Responsibilities, in order:
 *  1. Install the network hooks as early as possible (document-start) so the
 *     DeepSeek bundle cannot capture the original fetch/XHR first.
 *  2. Load the personalization state (memories, preset, project, settings).
 *  3. Augment every outgoing chat request with that state.
 *  4. Execute memory tool calls the model emits in its reply.
 *  5. Mount the management panel once the DOM is ready.
 */

import { SCRIPT_NAME } from './constants';
import { detectLocale, translateUi } from './i18n';
import type { SupportedLocale, ToolCall, ToolDescriptor } from './types';
import { getAllMemories, touchMemories } from './memory/store';
import { getActiveProject, getActivePreset } from './preset/store';
import { getEnabledSkills } from './skill/store';
import {
  getPromptInjectionSettings,
  type PromptInjectionSettings,
} from './prompt/settings';
import { augmentDecodedRequestBody } from './prompt/request-augmentation';
import { decodeDeepSeekRequestBody } from './deepseek/routes';
import { createMemoryToolDescriptors, executeMemoryToolCall, isMemoryToolName } from './tool/memory-tools';
import { installNetworkHooks, updateHookState } from './interceptor/network-hook';
import { mountPanel, type PanelController } from './ui/panel';
import { showToast } from './ui/toast';

const TOOL_DESCRIPTORS: ToolDescriptor[] = createMemoryToolDescriptors();

interface RuntimeState {
  locale: SupportedLocale;
  settings: PromptInjectionSettings;
  /** Per-chat-session message counters, driving preset re-injection cadence. */
  messageCounts: Map<string, number>;
}

const state: RuntimeState = {
  locale: detectLocale(),
  settings: {
    memoryEnabled: true,
    systemPromptEnabled: true,
    presetCadence: 'default',
    forceResponseLanguage: 'auto',
    showActivityToasts: true,
    uiLocale: 'auto',
  },
  messageCounts: new Map(),
};

let panel: PanelController | null = null;

async function refreshSettings(): Promise<void> {
  state.settings = await getPromptInjectionSettings();
  state.locale =
    state.settings.uiLocale === 'auto' ? detectLocale() : state.settings.uiLocale;
}

/**
 * Builds the augmented request body. Every dependency is re-read per request so
 * a memory saved mid-conversation is visible on the very next turn.
 */
async function handleRequestBody(
  body: string,
): Promise<{ body: string; originalPrompt: string } | null> {
  const decoded = decodeDeepSeekRequestBody(body);
  if (!decoded) return null;

  await refreshSettings();

  const [memories, activePreset, activeProject, skills] = await Promise.all([
    getAllMemories(),
    getActivePreset(),
    getActiveProject(),
    getEnabledSkills(),
  ]);

  const sessionId =
    typeof decoded.chat_session_id === 'string' ? decoded.chat_session_id : 'unknown';
  const messageCount = state.messageCounts.get(sessionId) ?? 0;

  const result = augmentDecodedRequestBody(decoded, {
    memories,
    skills: skills.map((skill) => ({
      name: skill.name,
      instructions: skill.instructions,
      memoryEnabled: skill.memoryEnabled,
    })),
    activePreset,
    projectContext: activeProject?.instructions ?? null,
    projectId: activeProject?.id ?? null,
    toolDescriptors: TOOL_DESCRIPTORS,
    messageCount,
    locale: state.locale,
    promptSettings: state.settings,
  });

  state.messageCounts.set(sessionId, result.messageCount);

  // Injected memories are "used": bump their access stats so the decay score
  // keeps frequently relevant memories near the top.
  if (result.usedMemoryIds.length > 0) {
    void touchMemories(result.usedMemoryIds).catch((error) =>
      console.error(`[${SCRIPT_NAME}] touchMemories failed`, error),
    );
    if (state.settings.showActivityToasts) {
      showToast(
        translateUi(state.locale, 'memoryInjected', { count: result.usedMemoryIds.length }),
      );
    }
  }

  return { body: result.body, originalPrompt: result.originalPrompt };
}

/** Executes a memory tool call emitted by the model. */
async function handleToolCall(call: ToolCall): Promise<void> {
  if (!isMemoryToolName(call.name)) return;
  try {
    const result = await executeMemoryToolCall(call, state.locale);
    if (state.settings.showActivityToasts) showToast(result.summary);
    if (!result.ok) {
      console.warn(`[${SCRIPT_NAME}] memory tool failed`, result.error);
    }
    await panel?.refresh();
  } catch (error) {
    console.error(`[${SCRIPT_NAME}] memory tool execution failed`, error);
  }
}

function bootstrapPanel(): void {
  if (panel) return;
  panel = mountPanel({
    locale: state.locale,
    onStateChanged: async () => {
      await refreshSettings();
    },
  });

  // Tampermonkey menu entry, when the grant is available.
  const registerMenuCommand = (globalThis as Record<string, unknown>)
    .GM_registerMenuCommand as ((name: string, fn: () => void) => void) | undefined;
  registerMenuCommand?.(translateUi(state.locale, 'openPanel'), () => panel?.open());
}

function whenDomReady(callback: () => void): void {
  if (document.body) {
    callback();
    return;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback, { once: true });
    return;
  }
  // readyState is interactive/complete but body is missing: poll briefly.
  const timer = setInterval(() => {
    if (!document.body) return;
    clearInterval(timer);
    callback();
  }, 50);
}

function main(): void {
  // Hooks first: DeepSeek's bundle must not capture the original fetch/XHR
  // before we wrap them. A hook failure degrades interception only — the panel
  // must still mount, otherwise the user loses all manual control too.
  try {
    installNetworkHooks();
    updateHookState({
      toolDescriptors: TOOL_DESCRIPTORS,
      onRequestBody: (body) => handleRequestBody(body),
      onToolCall: (call) => void handleToolCall(call),
      onResponseComplete: () => undefined,
    });
  } catch (error) {
    console.error(`[${SCRIPT_NAME}] network hooks failed to install`, error);
  }

  void refreshSettings().catch((error) =>
    console.error(`[${SCRIPT_NAME}] settings load failed`, error),
  );

  whenDomReady(() => {
    void refreshSettings()
      .catch(() => undefined)
      .then(() => {
        try {
          bootstrapPanel();
        } catch (error) {
          console.error(`[${SCRIPT_NAME}] panel mount failed`, error);
        }
      });
  });

  console.info(`[${SCRIPT_NAME}] ready`);
}

main();
