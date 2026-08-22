/**
 * The management panel: memories, presets, skills and injection settings.
 *
 * Mounted in a shadow root attached to a dedicated host element so DeepSeek's
 * SPA re-renders cannot remove or restyle it.
 */

import type { Memory, MemoryType, SupportedLocale, SystemPromptPreset } from '../types';
import { translateUi } from '../i18n';
import {
  archiveStaleMemories,
  createSyncId,
  deleteMemory,
  getAllMemories,
  importMemoriesAtomically,
  saveMemory,
  updateMemory,
} from '../memory/store';
import {
  deletePreset,
  getActivePresetId,
  getAllPresets,
  savePreset,
  setActivePresetId,
} from '../preset/store';
import {
  deleteSkill,
  getAllSkills,
  saveSkill,
  type UserSkill,
} from '../skill/store';
import {
  getPromptInjectionSettings,
  savePromptInjectionSettings,
  type PromptInjectionSettings,
} from '../prompt/settings';
import { PANEL_STYLES } from './styles';
import { clear, downloadJson, el, formatTimestamp, pickJsonFile } from './dom';
import { createToastHost, showToast } from './toast';

const HOST_ID = 'dspp-userscript-host';

type TabId = 'memories' | 'presets' | 'skills' | 'settings';

export interface PanelController {
  open(): void;
  close(): void;
  toggle(): void;
  refresh(): Promise<void>;
  destroy(): void;
}

export interface PanelOptions {
  locale: SupportedLocale;
  /** Called after any change that affects prompt building. */
  onStateChanged: () => void | Promise<void>;
}

export function mountPanel(options: PanelOptions): PanelController {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_STYLES;
  root.appendChild(style);
  (document.body ?? document.documentElement).appendChild(host);

  const t = (key: string, params?: Record<string, string | number>) =>
    translateUi(options.locale, key, params);

  createToastHost(root);
  syncTheme(host);

  let activeTab: TabId = 'memories';
  let memoryQuery = '';
  let editingMemory: Memory | null = null;
  let creatingMemory = false;
  let editingPreset: SystemPromptPreset | null = null;
  let creatingPreset = false;
  let editingSkill: UserSkill | null = null;
  let creatingSkill = false;

  const bodyEl = el('div', { class: 'dspp-body' });
  const tabsEl = el('div', { class: 'dspp-tabs' });

  const panel = el('div', { class: 'dspp-panel' }, [
    el('div', { class: 'dspp-header' }, [
      el('div', { class: 'dspp-title', text: t('panelTitle') }),
      el('button', {
        class: 'dspp-close',
        text: '\u00d7',
        attrs: { 'aria-label': 'Close' },
        on: { click: () => controller.close() },
      }),
    ]),
    tabsEl,
    bodyEl,
  ]);

  const overlay = el('div', { class: 'dspp-overlay', hidden: true }, [panel]);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) controller.close();
  });
  root.appendChild(overlay);

  const fab = el('button', {
    class: 'dspp-fab',
    text: 'M+',
    attrs: { title: t('openPanel'), 'aria-label': t('openPanel') },
    on: { click: () => controller.toggle() },
  });
  root.appendChild(fab);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !overlay.hidden) controller.close();
  };
  document.addEventListener('keydown', onKeyDown);

  function renderTabs(): void {
    clear(tabsEl);
    const tabs: Array<[TabId, string]> = [
      ['memories', t('tabMemories')],
      ['presets', t('tabPresets')],
      ['skills', 'Skills'],
      ['settings', t('tabSettings')],
    ];
    for (const [id, label] of tabs) {
      tabsEl.appendChild(
        el('button', {
          class: `dspp-tab${activeTab === id ? ' is-active' : ''}`,
          text: label,
          on: {
            click: () => {
              activeTab = id;
              editingMemory = null;
              creatingMemory = false;
              editingPreset = null;
              creatingPreset = false;
              editingSkill = null;
              creatingSkill = false;
              void render();
            },
          },
        }),
      );
    }
  }

  async function render(): Promise<void> {
    renderTabs();
    clear(bodyEl);
    try {
      if (activeTab === 'memories') await renderMemories();
      else if (activeTab === 'presets') await renderPresets();
      else if (activeTab === 'skills') await renderSkills();
      else await renderSettings();
    } catch (error) {
      bodyEl.appendChild(
        el('div', {
          class: 'dspp-empty',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    }
  }

  // --- Memories ---------------------------------------------------------------

  async function renderMemories(): Promise<void> {
    if (creatingMemory || editingMemory) {
      bodyEl.appendChild(renderMemoryForm(editingMemory));
      return;
    }

    const memories = await getAllMemories();
    const query = memoryQuery.trim().toLowerCase();
    const filtered = query
      ? memories.filter(
          (memory) =>
            memory.name.toLowerCase().includes(query) ||
            memory.content.toLowerCase().includes(query) ||
            memory.tags.some((tag) => tag.toLowerCase().includes(query)),
        )
      : memories;

    // Pinned first, then most recently used.
    filtered.sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return right.lastAccessedAt - left.lastAccessedAt;
    });

    const searchInput = el('input', {
      class: 'dspp-search',
      type: 'search',
      value: memoryQuery,
      attrs: { placeholder: t('searchPlaceholder') },
    }) as HTMLInputElement;
    searchInput.addEventListener('input', () => {
      memoryQuery = searchInput.value;
      void render().then(() => {
        const next = bodyEl.querySelector<HTMLInputElement>('.dspp-search');
        next?.focus();
        next?.setSelectionRange(next.value.length, next.value.length);
      });
    });

    bodyEl.appendChild(
      el('div', { class: 'dspp-toolbar' }, [
        searchInput,
        el('button', {
          class: 'dspp-btn is-primary',
          text: t('addMemory'),
          on: {
            click: () => {
              creatingMemory = true;
              void render();
            },
          },
        }),
        el('button', {
          class: 'dspp-btn',
          text: t('exportData'),
          on: { click: () => void exportAll() },
        }),
        el('button', {
          class: 'dspp-btn',
          text: t('importData'),
          on: { click: () => void importAll() },
        }),
        el('button', {
          class: 'dspp-btn',
          text: t('archiveStale'),
          on: {
            click: async () => {
              const count = await archiveStaleMemories();
              showToast(t('archivedToast', { count }));
              await options.onStateChanged();
              await render();
            },
          },
        }),
      ]),
    );

    bodyEl.appendChild(
      el('div', { class: 'dspp-stats', text: t('stats', { count: memories.length }) }),
    );

    if (filtered.length === 0) {
      bodyEl.appendChild(el('div', { class: 'dspp-empty', text: t('empty') }));
      return;
    }

    const list = el('div', { class: 'dspp-list' });
    for (const memory of filtered) list.appendChild(renderMemoryCard(memory));
    bodyEl.appendChild(list);
  }

  function renderMemoryCard(memory: Memory): HTMLElement {
    return el('div', { class: 'dspp-card' }, [
      el('div', { class: 'dspp-card-head' }, [
        el('span', { class: 'dspp-card-name', text: memory.name }),
        el('span', {
          class: `dspp-badge is-${memory.type}`,
          text: t(memoryTypeLabelKey(memory.type)),
        }),
        memory.pinned && el('span', { class: 'dspp-badge is-pinned', text: '\u2605' }),
      ]),
      el('div', { class: 'dspp-card-content', text: memory.content }),
      el('div', { class: 'dspp-card-meta' }, [
        ...memory.tags.map((tag) => el('span', { class: 'dspp-badge', text: tag })),
        el('span', {
          class: 'dspp-badge',
          text: `#${memory.id} \u00b7 ${formatTimestamp(memory.updatedAt)} \u00b7 \u00d7${memory.accessCount}`,
        }),
        el('span', { style: 'flex:1' }),
        el('div', { class: 'dspp-card-actions' }, [
          el('button', {
            class: 'dspp-btn is-small',
            text: memory.pinned ? t('unpin') : t('pin'),
            on: {
              click: async () => {
                await updateMemory({ ...memory, pinned: !memory.pinned });
                await options.onStateChanged();
                await render();
              },
            },
          }),
          el('button', {
            class: 'dspp-btn is-small',
            text: t('editMemory'),
            on: {
              click: () => {
                editingMemory = memory;
                void render();
              },
            },
          }),
          el('button', {
            class: 'dspp-btn is-small is-danger',
            text: t('deleteMemory'),
            on: {
              click: async () => {
                if (!confirm(t('confirmDelete'))) return;
                if (memory.id === undefined) return;
                await deleteMemory(memory.id);
                await options.onStateChanged();
                await render();
              },
            },
          }),
        ]),
      ]),
    ]);
  }

  function renderMemoryForm(memory: Memory | null): HTMLElement {
    const nameInput = el('input', {
      type: 'text',
      value: memory?.name ?? '',
    }) as HTMLInputElement;
    const contentInput = el('textarea', {
      value: memory?.content ?? '',
    }) as HTMLTextAreaElement;
    const tagsInput = el('input', {
      type: 'text',
      value: (memory?.tags ?? []).join(', '),
    }) as HTMLInputElement;
    const typeSelect = el('select', {}, [
      ...(['user', 'feedback', 'topic', 'reference'] as MemoryType[]).map((type) =>
        el('option', {
          value: type,
          text: t(memoryTypeLabelKey(type)),
          selected: (memory?.type ?? 'user') === type,
        }),
      ),
    ]) as HTMLSelectElement;

    return el('div', {}, [
      el('div', { class: 'dspp-field' }, [
        el('label', { text: t('name') }),
        nameInput,
      ]),
      el('div', { class: 'dspp-field' }, [
        el('label', { text: t('content') }),
        contentInput,
      ]),
      el('div', { class: 'dspp-row' }, [
        el('div', { class: 'dspp-field' }, [el('label', { text: t('type') }), typeSelect]),
        el('div', { class: 'dspp-field' }, [el('label', { text: t('tags') }), tagsInput]),
      ]),
      el('div', { class: 'dspp-form-actions' }, [
        el('button', {
          class: 'dspp-btn',
          text: t('cancel'),
          on: {
            click: () => {
              editingMemory = null;
              creatingMemory = false;
              void render();
            },
          },
        }),
        el('button', {
          class: 'dspp-btn is-primary',
          text: t('save'),
          on: {
            click: async () => {
              const name = nameInput.value.trim();
              const content = contentInput.value.trim();
              if (!name || !content) return;
              const tags = tagsInput.value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean);
              const type = typeSelect.value as MemoryType;

              if (memory?.id !== undefined) {
                await updateMemory({ ...memory, name, content, tags, type, description: name });
              } else {
                await saveMemory({
                  type,
                  name,
                  content,
                  description: name,
                  tags,
                  pinned: false,
                });
              }
              editingMemory = null;
              creatingMemory = false;
              showToast(t('savedToast'));
              await options.onStateChanged();
              await render();
            },
          },
        }),
      ]),
    ]);
  }

  // --- Presets ----------------------------------------------------------------

  async function renderPresets(): Promise<void> {
    if (creatingPreset || editingPreset) {
      bodyEl.appendChild(renderPresetForm(editingPreset));
      return;
    }

    const [presets, activeId] = [await getAllPresets(), getActivePresetId()];

    bodyEl.appendChild(
      el('div', { class: 'dspp-toolbar' }, [
        el('button', {
          class: 'dspp-btn is-primary',
          text: t('newPreset'),
          on: {
            click: () => {
              creatingPreset = true;
              void render();
            },
          },
        }),
        activeId &&
          el('button', {
            class: 'dspp-btn',
            text: `${t('activePreset')}: ${t('none')}`,
            on: {
              click: async () => {
                await setActivePresetId(null);
                await options.onStateChanged();
                await render();
              },
            },
          }),
      ]),
    );

    if (presets.length === 0) {
      bodyEl.appendChild(el('div', { class: 'dspp-empty', text: t('empty') }));
      return;
    }

    const list = el('div', { class: 'dspp-list' });
    for (const preset of presets) {
      const isActive = preset.id === activeId;
      list.appendChild(
        el('div', { class: 'dspp-card' }, [
          el('div', { class: 'dspp-card-head' }, [
            el('span', { class: 'dspp-card-name', text: preset.name }),
            isActive && el('span', { class: 'dspp-badge is-user', text: t('activePreset') }),
          ]),
          el('div', {
            class: 'dspp-card-content',
            text:
              preset.content.length > 300
                ? `${preset.content.slice(0, 300)}\u2026`
                : preset.content,
          }),
          el('div', { class: 'dspp-card-meta' }, [
            el('span', { style: 'flex:1' }),
            el('div', { class: 'dspp-card-actions' }, [
              el('button', {
                class: 'dspp-btn is-small',
                text: isActive ? t('none') : t('activePreset'),
                on: {
                  click: async () => {
                    await setActivePresetId(isActive ? null : preset.id);
                    await options.onStateChanged();
                    await render();
                  },
                },
              }),
              el('button', {
                class: 'dspp-btn is-small',
                text: t('editMemory'),
                on: {
                  click: () => {
                    editingPreset = preset;
                    void render();
                  },
                },
              }),
              el('button', {
                class: 'dspp-btn is-small is-danger',
                text: t('deleteMemory'),
                on: {
                  click: async () => {
                    if (!confirm(t('confirmDelete'))) return;
                    await deletePreset(preset.id);
                    await options.onStateChanged();
                    await render();
                  },
                },
              }),
            ]),
          ]),
        ]),
      );
    }
    bodyEl.appendChild(list);
  }

  function renderPresetForm(preset: SystemPromptPreset | null): HTMLElement {
    const nameInput = el('input', {
      type: 'text',
      value: preset?.name ?? '',
    }) as HTMLInputElement;
    const contentInput = el('textarea', {
      value: preset?.content ?? '',
      style: 'min-height:220px',
    }) as HTMLTextAreaElement;

    return el('div', {}, [
      el('div', { class: 'dspp-field' }, [el('label', { text: t('presetName') }), nameInput]),
      el('div', { class: 'dspp-field' }, [
        el('label', { text: t('presetContent') }),
        contentInput,
      ]),
      el('div', { class: 'dspp-form-actions' }, [
        el('button', {
          class: 'dspp-btn',
          text: t('cancel'),
          on: {
            click: () => {
              editingPreset = null;
              creatingPreset = false;
              void render();
            },
          },
        }),
        el('button', {
          class: 'dspp-btn is-primary',
          text: t('save'),
          on: {
            click: async () => {
              const name = nameInput.value.trim();
              if (!name) return;
              const now = Date.now();
              await savePreset({
                id: preset?.id ?? createSyncId(),
                name,
                content: contentInput.value,
                createdAt: preset?.createdAt ?? now,
                updatedAt: now,
              });
              editingPreset = null;
              creatingPreset = false;
              showToast(t('savedToast'));
              await options.onStateChanged();
              await render();
            },
          },
        }),
      ]),
    ]);
  }

  // --- Skills -----------------------------------------------------------------

  async function renderSkills(): Promise<void> {
    if (creatingSkill || editingSkill) {
      bodyEl.appendChild(renderSkillForm(editingSkill));
      return;
    }

    const skills = await getAllSkills();

    bodyEl.appendChild(
      el('div', { class: 'dspp-toolbar' }, [
        el('button', {
          class: 'dspp-btn is-primary',
          text: 'New skill',
          on: {
            click: () => {
              creatingSkill = true;
              void render();
            },
          },
        }),
      ]),
    );
    bodyEl.appendChild(
      el('div', { class: 'dspp-hint' }, [
        document.createTextNode('Type '),
        el('code', { text: '/skill-name your text' }),
        document.createTextNode(
          ' in DeepSeek to expand a skill into its instructions for that turn.',
        ),
      ]),
    );

    if (skills.length === 0) {
      bodyEl.appendChild(el('div', { class: 'dspp-empty', text: t('empty') }));
      return;
    }

    const list = el('div', { class: 'dspp-list' });
    for (const skill of skills) {
      list.appendChild(
        el('div', { class: 'dspp-card' }, [
          el('div', { class: 'dspp-card-head' }, [
            el('span', { class: 'dspp-card-name', text: `/${skill.name}` }),
            !skill.enabled && el('span', { class: 'dspp-badge', text: 'off' }),
            !skill.memoryEnabled && el('span', { class: 'dspp-badge', text: 'identity-only' }),
          ]),
          el('div', { class: 'dspp-card-content', text: skill.description || skill.instructions.slice(0, 200) }),
          el('div', { class: 'dspp-card-meta' }, [
            el('span', { style: 'flex:1' }),
            el('div', { class: 'dspp-card-actions' }, [
              el('button', {
                class: 'dspp-btn is-small',
                text: skill.enabled ? 'Disable' : 'Enable',
                on: {
                  click: async () => {
                    await saveSkill({ ...skill, enabled: !skill.enabled });
                    await options.onStateChanged();
                    await render();
                  },
                },
              }),
              el('button', {
                class: 'dspp-btn is-small',
                text: t('editMemory'),
                on: {
                  click: () => {
                    editingSkill = skill;
                    void render();
                  },
                },
              }),
              el('button', {
                class: 'dspp-btn is-small is-danger',
                text: t('deleteMemory'),
                on: {
                  click: async () => {
                    if (!confirm(t('confirmDelete'))) return;
                    await deleteSkill(skill.name);
                    await options.onStateChanged();
                    await render();
                  },
                },
              }),
            ]),
          ]),
        ]),
      );
    }
    bodyEl.appendChild(list);
  }

  function renderSkillForm(skill: UserSkill | null): HTMLElement {
    const nameInput = el('input', {
      type: 'text',
      value: skill?.name ?? '',
      attrs: { placeholder: 'translate' },
    }) as HTMLInputElement;
    const descriptionInput = el('input', {
      type: 'text',
      value: skill?.description ?? '',
    }) as HTMLInputElement;
    const instructionsInput = el('textarea', {
      value: skill?.instructions ?? '',
      style: 'min-height:200px',
    }) as HTMLTextAreaElement;
    const memoryCheckbox = el('input', {
      type: 'checkbox',
      checked: skill?.memoryEnabled !== false,
    }) as HTMLInputElement;

    return el('div', {}, [
      el('div', { class: 'dspp-row' }, [
        el('div', { class: 'dspp-field' }, [
          el('label', { text: 'Trigger (/name)' }),
          nameInput,
        ]),
        el('div', { class: 'dspp-field' }, [
          el('label', { text: 'Description' }),
          descriptionInput,
        ]),
      ]),
      el('div', { class: 'dspp-field' }, [
        el('label', { text: 'Instructions' }),
        instructionsInput,
      ]),
      el('label', { class: 'dspp-switch' }, [
        memoryCheckbox,
        el('span', { class: 'dspp-switch-label', text: 'Inject full memory set (off = identity only)' }),
      ]),
      el('div', { class: 'dspp-form-actions' }, [
        el('button', {
          class: 'dspp-btn',
          text: t('cancel'),
          on: {
            click: () => {
              editingSkill = null;
              creatingSkill = false;
              void render();
            },
          },
        }),
        el('button', {
          class: 'dspp-btn is-primary',
          text: t('save'),
          on: {
            click: async () => {
              const name = nameInput.value.trim().replace(/^\//, '');
              if (!name || /\s/.test(name)) return;
              const now = Date.now();
              await saveSkill(
                {
                  name,
                  description: descriptionInput.value.trim(),
                  instructions: instructionsInput.value,
                  memoryEnabled: memoryCheckbox.checked,
                  enabled: skill?.enabled !== false,
                  createdAt: skill?.createdAt ?? now,
                  updatedAt: now,
                },
                skill?.name,
              );
              editingSkill = null;
              creatingSkill = false;
              showToast(t('savedToast'));
              await options.onStateChanged();
              await render();
            },
          },
        }),
      ]),
    ]);
  }

  // --- Settings ---------------------------------------------------------------

  async function renderSettings(): Promise<void> {
    const settings = await getPromptInjectionSettings();

    const update = async (patch: Partial<PromptInjectionSettings>) => {
      await savePromptInjectionSettings(patch);
      await options.onStateChanged();
      showToast(t('savedToast'));
    };

    bodyEl.appendChild(
      switchRow(t('memoryEnabled'), settings.memoryEnabled, (checked) =>
        update({ memoryEnabled: checked }),
      ),
    );
    bodyEl.appendChild(
      switchRow(t('systemPromptEnabled'), settings.systemPromptEnabled, (checked) =>
        update({ systemPromptEnabled: checked }),
      ),
    );
    bodyEl.appendChild(
      switchRow('Activity toasts', settings.showActivityToasts, (checked) =>
        update({ showActivityToasts: checked }),
      ),
    );

    bodyEl.appendChild(
      selectRow(
        t('presetCadence'),
        [
          ['default', t('cadenceDefault')],
          ['first_message', t('cadenceFirst')],
          ['every_message', t('cadenceEvery')],
          ['off', t('cadenceOff')],
        ],
        settings.presetCadence,
        (value) => update({ presetCadence: value as PromptInjectionSettings['presetCadence'] }),
      ),
    );

    bodyEl.appendChild(
      selectRow(
        t('forceLanguage'),
        [
          ['auto', t('languageAuto')],
          ['zh-CN', t('languageZh')],
          ['en', t('languageEn')],
        ],
        settings.forceResponseLanguage,
        (value) =>
          update({
            forceResponseLanguage: value as PromptInjectionSettings['forceResponseLanguage'],
          }),
      ),
    );

    bodyEl.appendChild(
      selectRow(
        'Interface language',
        [
          ['auto', t('languageAuto')],
          ['zh-CN', t('languageZh')],
          ['en', t('languageEn')],
        ],
        settings.uiLocale,
        (value) => update({ uiLocale: value as PromptInjectionSettings['uiLocale'] }),
      ),
    );

    bodyEl.appendChild(
      el('div', { class: 'dspp-toolbar', style: 'margin-top:16px' }, [
        el('button', {
          class: 'dspp-btn',
          text: t('exportData'),
          on: { click: () => void exportAll() },
        }),
        el('button', {
          class: 'dspp-btn',
          text: t('importData'),
          on: { click: () => void importAll() },
        }),
      ]),
    );
  }

  function switchRow(
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void | Promise<void>,
  ): HTMLElement {
    const input = el('input', { type: 'checkbox', checked }) as HTMLInputElement;
    input.addEventListener('change', () => void onChange(input.checked));
    return el('label', { class: 'dspp-switch' }, [
      input,
      el('span', { class: 'dspp-switch-label', text: label }),
    ]);
  }

  function selectRow(
    label: string,
    entries: Array<[string, string]>,
    value: string,
    onChange: (value: string) => void | Promise<void>,
  ): HTMLElement {
    const select = el(
      'select',
      {},
      entries.map(([entryValue, entryLabel]) =>
        el('option', { value: entryValue, text: entryLabel, selected: entryValue === value }),
      ),
    ) as HTMLSelectElement;
    select.addEventListener('change', () => void onChange(select.value));
    return el('div', { class: 'dspp-field', style: 'margin-top:10px' }, [
      el('label', { text: label }),
      select,
    ]);
  }

  // --- Import / export --------------------------------------------------------

  async function exportAll(): Promise<void> {
    const [memories, presets, skills, settings] = await Promise.all([
      getAllMemories(),
      getAllPresets(),
      getAllSkills(),
      getPromptInjectionSettings(),
    ]);
    downloadJson(`deepseek-pp-userscript-${new Date().toISOString().slice(0, 10)}.json`, {
      schemaVersion: 1,
      exportedAt: Date.now(),
      memories,
      presets,
      activePresetId: getActivePresetId(),
      skills,
      settings,
    });
  }

  async function importAll(): Promise<void> {
    const data = await pickJsonFile();
    if (!data || typeof data !== 'object') return;
    const payload = data as Record<string, unknown>;

    let importedCount = 0;
    if (Array.isArray(payload.memories)) {
      // syncId dedup means re-importing the same file updates instead of
      // duplicating, so this is safe to run repeatedly.
      const ids = await importMemoriesAtomically(payload.memories as never[]);
      importedCount = ids.length;
    }
    if (Array.isArray(payload.presets)) {
      for (const preset of payload.presets) {
        await savePreset(preset as SystemPromptPreset);
      }
    }
    if (Array.isArray(payload.skills)) {
      for (const skill of payload.skills) {
        await saveSkill(skill as UserSkill);
      }
    }
    if (payload.settings && typeof payload.settings === 'object') {
      await savePromptInjectionSettings(payload.settings as Partial<PromptInjectionSettings>);
    }

    showToast(t('importedToast', { count: importedCount }));
    await options.onStateChanged();
    await render();
  }

  const controller: PanelController = {
    open() {
      overlay.hidden = false;
      syncTheme(host);
      void render();
    },
    close() {
      overlay.hidden = true;
    },
    toggle() {
      if (overlay.hidden) controller.open();
      else controller.close();
    },
    refresh() {
      return overlay.hidden ? Promise.resolve() : render();
    },
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      host.remove();
    },
  };

  return controller;
}

function memoryTypeLabelKey(type: MemoryType): string {
  switch (type) {
    case 'user':
      return 'typeUser';
    case 'feedback':
      return 'typeFeedback';
    case 'topic':
      return 'typeTopic';
    case 'reference':
    default:
      return 'typeReference';
  }
}

/** Mirrors DeepSeek's light/dark choice onto the shadow host. */
function syncTheme(host: HTMLElement): void {
  const documentTheme =
    document.documentElement.getAttribute('data-theme') ??
    document.body?.getAttribute('data-theme');
  const prefersDark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = documentTheme ? documentTheme.includes('dark') : prefersDark;
  host.setAttribute('data-theme', isDark ? 'dark' : 'light');
}
