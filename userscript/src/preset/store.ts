/**
 * Userscript port of core/preset/store.ts + core/preset/codec.ts.
 *
 * Presets are the "system prompt persona" half of personalization. Storage
 * keys match the extension so exported presets are portable.
 */

import type { Project, SystemPromptPreset } from '../types';
import { createRepository, readSlot, removeSlot, writeSlot } from '../storage';

export const PRESETS_STORAGE_KEY = 'deepseek_pp_presets';
export const ACTIVE_PRESET_STORAGE_KEY = 'deepseek_pp_active_preset_id';
export const PROJECTS_STORAGE_KEY = 'deepseek_pp_projects';
export const ACTIVE_PROJECT_STORAGE_KEY = 'deepseek_pp_active_project_id';

export function decodePreset(value: unknown, path = 'preset'): SystemPromptPreset {
  const object = recordValue(value, path);
  return {
    ...object,
    id: requiredString(object.id, `${path}.id`),
    name: stringValue(object.name, `${path}.name`),
    content: stringValue(object.content, `${path}.content`),
    createdAt: finiteNumber(object.createdAt, `${path}.createdAt`),
    updatedAt: finiteNumber(object.updatedAt, `${path}.updatedAt`),
  } as SystemPromptPreset;
}

export function decodePresetCollection(value: unknown, path = 'presets'): SystemPromptPreset[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => decodePreset(item, `${path}[${index}]`));
}

const presetRepository = createRepository<SystemPromptPreset[]>({
  key: PRESETS_STORAGE_KEY,
  createDefault: () => [],
  decode: (value) => decodePresetCollection(value),
});

export function getAllPresets(): Promise<SystemPromptPreset[]> {
  return presetRepository.read();
}

export async function savePreset(preset: SystemPromptPreset): Promise<void> {
  const decoded = decodePreset(preset, 'preset');
  await presetRepository.update((presets) => {
    const index = presets.findIndex((item) => item.id === decoded.id);
    const next = [...presets];
    if (index >= 0) next[index] = { ...next[index], ...decoded };
    else next.push(decoded);
    return next;
  });
}

export async function deletePreset(id: string): Promise<void> {
  requireNonEmptyId(id, 'Preset id');
  await presetRepository.update((presets) => presets.filter((preset) => preset.id !== id));
  if (getActivePresetId() === id) removeSlot(ACTIVE_PRESET_STORAGE_KEY);
}

export function getActivePresetId(): string | null {
  const slot = readSlot(ACTIVE_PRESET_STORAGE_KEY);
  if (!slot.present) return null;
  if (typeof slot.value !== 'string') {
    throw new Error('activePresetId must be a string');
  }
  return slot.value;
}

export async function setActivePresetId(id: string | null): Promise<void> {
  if (id === null) {
    removeSlot(ACTIVE_PRESET_STORAGE_KEY);
    return;
  }
  requireNonEmptyId(id, 'Preset id');
  const presets = await getAllPresets();
  if (!presets.some((preset) => preset.id === id)) {
    throw new Error(`Preset was not found: ${id}`);
  }
  writeSlot(ACTIVE_PRESET_STORAGE_KEY, id);
}

export async function getActivePreset(): Promise<SystemPromptPreset | null> {
  const activeId = getActivePresetId();
  if (!activeId) return null;
  const presets = await getAllPresets();
  return presets.find((preset) => preset.id === activeId) ?? null;
}

// --- Projects: project instructions + project-scoped memory ------------------

export function decodeProject(value: unknown, path = 'project'): Project {
  const object = recordValue(value, path);
  return {
    ...object,
    id: requiredString(object.id, `${path}.id`),
    name: stringValue(object.name, `${path}.name`),
    instructions: stringValue(object.instructions, `${path}.instructions`),
    createdAt: finiteNumber(object.createdAt, `${path}.createdAt`),
    updatedAt: finiteNumber(object.updatedAt, `${path}.updatedAt`),
  } as Project;
}

const projectRepository = createRepository<Project[]>({
  key: PROJECTS_STORAGE_KEY,
  createDefault: () => [],
  decode: (value) => {
    if (!Array.isArray(value)) throw new Error('projects must be an array');
    return value.map((item, index) => decodeProject(item, `projects[${index}]`));
  },
});

export function getAllProjects(): Promise<Project[]> {
  return projectRepository.read();
}

export async function saveProject(project: Project): Promise<void> {
  const decoded = decodeProject(project, 'project');
  await projectRepository.update((projects) => {
    const index = projects.findIndex((item) => item.id === decoded.id);
    const next = [...projects];
    if (index >= 0) next[index] = { ...next[index], ...decoded };
    else next.push(decoded);
    return next;
  });
}

export async function deleteProject(id: string): Promise<void> {
  requireNonEmptyId(id, 'Project id');
  await projectRepository.update((projects) => projects.filter((project) => project.id !== id));
  if (getActiveProjectId() === id) removeSlot(ACTIVE_PROJECT_STORAGE_KEY);
}

export function getActiveProjectId(): string | null {
  const slot = readSlot(ACTIVE_PROJECT_STORAGE_KEY);
  if (!slot.present) return null;
  if (typeof slot.value !== 'string') throw new Error('activeProjectId must be a string');
  return slot.value;
}

export function setActiveProjectId(id: string | null): void {
  if (id === null) {
    removeSlot(ACTIVE_PROJECT_STORAGE_KEY);
    return;
  }
  requireNonEmptyId(id, 'Project id');
  writeSlot(ACTIVE_PROJECT_STORAGE_KEY, id);
}

export async function getActiveProject(): Promise<Project | null> {
  const activeId = getActiveProjectId();
  if (!activeId) return null;
  const projects = await getAllProjects();
  return projects.find((project) => project.id === activeId) ?? null;
}

function recordValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function requireNonEmptyId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}
