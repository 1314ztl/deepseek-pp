/**
 * Prompt-snippet ("Skill") store for the userscript.
 *
 * The extension's Skill system also supported GitHub import, bundled skill
 * packages and local directory indexing, all of which need extension-only
 * capabilities (file reads, host permissions). The userscript keeps the part
 * that works purely in-page: user-authored `/name` prompt snippets that expand
 * into instructions, with the same memoryEnabled semantics.
 */

import { createRepository } from '../storage';

export interface UserSkill {
  name: string;
  description: string;
  instructions: string;
  /** false = only identity memories are injected while this Skill runs. */
  memoryEnabled: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export const SKILLS_STORAGE_KEY = 'deepseek_pp_user_skills';

function decodeSkill(value: unknown, path: string): UserSkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const name = object.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(`${path}.name must be a non-empty string`);
  }
  const instructions = object.instructions;
  if (typeof instructions !== 'string') {
    throw new Error(`${path}.instructions must be a string`);
  }
  return {
    name,
    description: typeof object.description === 'string' ? object.description : '',
    instructions,
    memoryEnabled: object.memoryEnabled !== false,
    enabled: object.enabled !== false,
    createdAt: typeof object.createdAt === 'number' ? object.createdAt : Date.now(),
    updatedAt: typeof object.updatedAt === 'number' ? object.updatedAt : Date.now(),
  };
}

const repository = createRepository<UserSkill[]>({
  key: SKILLS_STORAGE_KEY,
  createDefault: () => [],
  decode: (value) => {
    if (!Array.isArray(value)) throw new Error('skills must be an array');
    return value.map((item, index) => decodeSkill(item, `skills[${index}]`));
  },
});

export function getAllSkills(): Promise<UserSkill[]> {
  return repository.read();
}

export async function getEnabledSkills(): Promise<UserSkill[]> {
  return (await repository.read()).filter((skill) => skill.enabled);
}

export async function saveSkill(skill: UserSkill, previousName?: string): Promise<void> {
  const decoded = decodeSkill(skill, 'skill');
  await repository.update((skills) => {
    const targetName = previousName ?? decoded.name;
    const index = skills.findIndex((item) => item.name === targetName);
    const next = [...skills];
    if (index >= 0) next[index] = { ...next[index], ...decoded, updatedAt: Date.now() };
    else next.push(decoded);
    return next;
  });
}

export async function deleteSkill(name: string): Promise<void> {
  await repository.update((skills) => skills.filter((skill) => skill.name !== name));
}

export function replaceAllSkills(skills: readonly UserSkill[]): Promise<UserSkill[]> {
  return repository.update(() => [...skills]);
}
