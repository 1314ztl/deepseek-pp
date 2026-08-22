/**
 * Userscript port of core/memory/scope.ts.
 *
 * Project-scoped memories are only visible inside their own project; legacy
 * records without a scope field are treated as global.
 */

import type { Memory } from '../types';

export function filterMemoriesByProjectScope(
  memories: readonly Memory[],
  projectId?: string | null,
): Memory[] {
  return memories.filter((memory) => {
    if (memory.scope === 'project') {
      return Boolean(projectId && memory.projectId === projectId);
    }
    return memory.scope === undefined || memory.scope === 'global';
  });
}
