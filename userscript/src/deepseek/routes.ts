/**
 * Userscript port of core/deepseek/request-codec.ts (route matching only).
 *
 * Only the three augmentable chat routes plus the history route matter for the
 * memory pipeline; everything else passes through untouched.
 */

import { DEEPSEEK_WEB_ROUTES } from '../constants';

export type DeepSeekRouteName = keyof typeof DEEPSEEK_WEB_ROUTES;
export type DeepSeekAugmentableRoute = 'completion' | 'editMessage' | 'regenerate';

const AUGMENTABLE_ROUTES = new Set<DeepSeekRouteName>([
  'completion',
  'editMessage',
  'regenerate',
]);

const ROUTE_METHODS: Record<DeepSeekRouteName, 'GET' | 'POST'> = {
  completion: 'POST',
  editMessage: 'POST',
  regenerate: 'POST',
  history: 'GET',
};

export function isAugmentableRoute(value: unknown): value is DeepSeekAugmentableRoute {
  return typeof value === 'string' && AUGMENTABLE_ROUTES.has(value as DeepSeekRouteName);
}

/**
 * Matches a request URL+method against the known DeepSeek routes. The pathname
 * is compared exactly (after normalization) so unrelated endpoints that merely
 * contain a similar substring are never intercepted.
 */
export function matchDeepSeekRoute(input: {
  url: string;
  method: string;
  baseUrl?: string;
}): DeepSeekRouteName | null {
  let pathname: string;
  try {
    pathname = new URL(input.url, input.baseUrl ?? location.href).pathname;
  } catch {
    return null;
  }

  const method = input.method.toUpperCase();
  for (const [name, path] of Object.entries(DEEPSEEK_WEB_ROUTES) as Array<
    [DeepSeekRouteName, string]
  >) {
    if (pathname !== path) continue;
    if (ROUTE_METHODS[name] !== method) continue;
    return name;
  }
  return null;
}

export interface DeepSeekRequestBody extends Record<string, unknown> {
  prompt: string;
}

export function decodeDeepSeekRequestBody(bodyStr: string): DeepSeekRequestBody | null {
  let value: unknown;
  try {
    value = JSON.parse(bodyStr);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.prompt !== 'string' || body.prompt.length === 0) return null;
  return body as DeepSeekRequestBody;
}
