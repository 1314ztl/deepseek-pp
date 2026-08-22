/**
 * Userscript port of the DeepSeek++ core type contracts.
 *
 * Only the types needed by the memory / personalization pipeline are ported.
 * Field names and value domains are kept byte-compatible with the extension so
 * memory exports can be moved between the two without conversion.
 */

export type MemoryType = 'user' | 'feedback' | 'topic' | 'reference';
export type MemoryScope = 'global' | 'project';

export interface Memory {
  id?: number;
  syncId: string;
  scope: MemoryScope;
  projectId?: string;
  type: MemoryType;
  name: string;
  content: string;
  description: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
}

export type NewMemory = Omit<
  Memory,
  'id' | 'syncId' | 'scope' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessedAt'
> & {
  syncId?: string;
  scope?: MemoryScope;
  projectId?: string;
};

export interface SystemPromptPreset {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  instructions: string;
  createdAt: number;
  updatedAt: number;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDescriptor {
  id: string;
  name: string;
  invocationName: string;
  title: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  invocationName: string;
  descriptorId?: string;
  payload: Record<string, unknown>;
  raw: string;
  parseError?: ToolError;
}

export interface ToolResult {
  ok: boolean;
  name: string;
  callId?: string;
  descriptorId?: string;
  summary: string;
  detail?: string;
  output?: JsonValue;
  error?: ToolError;
}

export interface ToolExecutionRecord {
  callId?: string;
  name: string;
  result: ToolResult;
}

export interface SSEEvent {
  id?: string;
  type: string;
  data: string;
}

export type SupportedLocale = 'zh-CN' | 'en';
