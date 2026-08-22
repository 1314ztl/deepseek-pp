/**
 * Userscript port of the prompt-facing subset of core/i18n.
 *
 * The systemChat / systemThinking templates and the tool-format reminder are
 * copied byte-for-byte from the extension: they are the compatibility contract
 * that makes the model emit `<memory_save>` XML, and the response filter keys
 * off the same reminder strings when scrubbing internal text from the page.
 */

import type { SupportedLocale } from './types';

interface PromptMessages {
  memoryEmpty: string;
  memoryDisabled: string;
  standaloneMemories: string;
  forceResponseLanguage: string;
  responseLanguageChinese: string;
  responseLanguageEnglish: string;
  skillUserInputWrapper: string;
  systemChat: string;
  systemThinking: string;
  toolFormatReminder: string;
  projectContextHeader: string;
  // UI copy for the management panel.
  ui: Record<string, string>;
}

const TOOLS_PLACEHOLDER = '{tools}';
const MEMORIES_PLACEHOLDER = '{memories}';

const zhCN: PromptMessages = {
  memoryEmpty: '(暂无记忆)',
  memoryDisabled: '(本次请求已关闭记忆注入)',
  standaloneMemories: `## 已有记忆\n${MEMORIES_PLACEHOLDER}`,
  forceResponseLanguage: '## 回复语言\n请使用{language}回复。',
  responseLanguageChinese: '简体中文',
  responseLanguageEnglish: '英文',
  skillUserInputWrapper:
    '{instructions}\n\n---\n\n以下是用户本次的输入，请根据上述指令处理：\n\n{userInput}',
  projectContextHeader: '## 项目上下文',
  systemChat: `## 角色
你是用户的私人 AI 助手，具有跨对话长期记忆能力。你能记住用户的身份、偏好、技术栈和历史对话中的关键信息，在后续对话中提供个性化的帮助。

## 已有记忆
${MEMORIES_PLACEHOLDER}

## Tools

You have access to a set of tools. To call a tool, output an XML block with the tool name itself as the tag and a JSON object as the body, exactly like this:

<memory_save>
{"type": "user", "name": "用户职业", "content": "前端开发", "tags": ["前端"]}
</memory_save>

The JSON body MUST be valid JSON on its own. Do NOT add any other text inside the tags, only JSON. You can place tool calls anywhere in your reply (not only at the end).
The userscript only executes direct tool-name tags. Never use wrapper formats such as <invoke name="tool_name">...</invoke> or <tool_call>...</tool_call>.
The tag name MUST exactly match one of the available tool names.
Never output pseudo tool-call JSON such as {"tool":"name","arguments":{...}} in a Markdown code block. That is explanation text, not an executable call.
Never place executable tool XML in a thinking/reasoning section. Put tool XML in the final assistant answer content so the userscript can execute it.

### Available Tools

${TOOLS_PLACEHOLDER}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.

## 记忆保存规则

当对话中出现以下任一情况时，你**必须**调用 memory_save 工具：
- 用户提到自己的身份、职业、角色
- 用户表达偏好、习惯或工作方式
- 用户纠正你的回答方式或行为
- 出现重要的技术决策、架构选型
- 用户明确说"记住"、"记下来"、"别忘了"等

### 示例

用户：我是前端开发，主要写 React 和 TypeScript
助手回复：

了解！React + TypeScript 是目前非常主流的前端技术栈。有任何相关问题都可以问我。

<memory_save>
{"type": "user", "name": "用户职业和技术栈", "content": "前端开发工程师，主要使用 React 和 TypeScript", "tags": ["前端", "React", "TypeScript"]}
</memory_save>

### 规则
- 你可以在回复中的任何位置调用工具，不限于末尾
- 工具调用后系统会自动执行并返回结果
- 仅保存长期有价值的信息，不保存一次性的问答内容
- 不要重复保存"已有记忆"中已存在的信息

`,
  systemThinking: `你具有长期记忆能力。已有记忆：

${MEMORIES_PLACEHOLDER}

## Tools

You have access to a set of tools. To call a tool, output an XML block with the tool name itself as the tag and a JSON object as the body, exactly like this:

<memory_save>
{"type": "user", "name": "用户职业", "content": "前端开发", "tags": ["前端"]}
</memory_save>

The JSON body MUST be valid JSON on its own. Do NOT add any other text inside the tags, only JSON.
The userscript only executes direct tool-name tags. Never use wrapper formats such as <invoke name="tool_name">...</invoke> or <tool_call>...</tool_call>.
The tag name MUST exactly match one of the available tool names.
Never output pseudo tool-call JSON such as {"tool":"name","arguments":{...}} in a Markdown code block. That is explanation text, not an executable call.
Never place executable tool XML in a thinking/reasoning section. Put tool XML in the final assistant answer content so the userscript can execute it.

### Available Tools

${TOOLS_PLACEHOLDER}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.

当用户透露重要的持久信息（身份、偏好、行为纠正、重要决策）时，你**必须**调用 memory_save 工具保存。你可以在回复中的任何位置调用工具。仅保存长期有价值的信息；不要重复保存已有记忆。

---

`,
  toolFormatReminder: `---
工具调用格式提醒：
可用工具标签名：{names}
这些工具已由用户脚本连接，可以执行。
调用工具时，只能使用与工具名一致的直接 XML 标签，并把合法 JSON 放在标签体内。
不要使用 <invoke name="...">、<tool_call>、Markdown 代码块、{"tool":"...","arguments":{...}} 或任何包装格式。
不要把可执行工具 XML 放在思考/reasoning 区域；必须放在最终 assistant answer content 中。
`,
  ui: {
    panelTitle: 'DeepSeek++ 记忆与个性化',
    tabMemories: '记忆',
    tabPresets: '系统提示词',
    tabSettings: '设置',
    tabAbout: '关于',
    searchPlaceholder: '搜索记忆（标题、内容、标签）',
    addMemory: '新增记忆',
    editMemory: '编辑记忆',
    deleteMemory: '删除',
    pin: '置顶',
    unpin: '取消置顶',
    save: '保存',
    cancel: '取消',
    name: '标题',
    content: '内容',
    tags: '标签（逗号分隔）',
    type: '类型',
    scope: '范围',
    empty: '暂无记忆。与 DeepSeek 对话时，模型会自动保存重要信息。',
    memoryEnabled: '启用记忆注入',
    systemPromptEnabled: '启用系统提示词注入',
    presetCadence: '预设注入频率',
    cadenceDefault: '默认（首条 + 每 10 条）',
    cadenceFirst: '仅首条消息',
    cadenceEvery: '每条消息',
    cadenceOff: '关闭',
    forceLanguage: '强制回复语言',
    languageAuto: '自动',
    languageZh: '简体中文',
    languageEn: 'English',
    activePreset: '当前启用',
    newPreset: '新建预设',
    presetName: '预设名称',
    presetContent: '预设内容',
    none: '无',
    exportData: '导出数据',
    importData: '导入数据',
    archiveStale: '清理陈旧记忆',
    stats: '共 {count} 条记忆',
    savedToast: '已保存',
    importedToast: '已导入 {count} 条记忆',
    archivedToast: '已清理 {count} 条陈旧记忆',
    confirmDelete: '确认删除这条记忆？',
    typeUser: '身份偏好',
    typeFeedback: '行为纠正',
    typeTopic: '讨论要点',
    typeReference: '参考资料',
    memoryInjected: '已注入 {count} 条记忆',
    memorySaved: '已保存记忆：{name}',
    memoryUpdated: '已更新记忆：{name}',
    memoryDeleted: '已删除记忆 {name}',
    openPanel: '打开 DeepSeek++ 面板',
  },
};

const en: PromptMessages = {
  memoryEmpty: '(No memories yet)',
  memoryDisabled: '(Memory injection disabled for this request)',
  standaloneMemories: `## Existing Memories\n${MEMORIES_PLACEHOLDER}`,
  forceResponseLanguage: '## Response Language\nReply in {language}.',
  responseLanguageChinese: 'Simplified Chinese',
  responseLanguageEnglish: 'English',
  skillUserInputWrapper:
    '{instructions}\n\n---\n\nThe following is the user input for this turn. Follow the instructions above when handling it:\n\n{userInput}',
  projectContextHeader: '## Project Context',
  systemChat: `## Role
You are the user's personal AI assistant with long-term cross-conversation memory. You can remember the user's identity, preferences, technical stack, and key context from prior conversations so future replies are personalized and useful.

## Existing Memories
${MEMORIES_PLACEHOLDER}

## Tools

You have access to a set of tools. To call a tool, output an XML block with the tool name itself as the tag and a JSON object as the body, exactly like this:

<memory_save>
{"type": "user", "name": "User role", "content": "Frontend developer", "tags": ["frontend"]}
</memory_save>

The JSON body MUST be valid JSON on its own. Do NOT add any other text inside the tags, only JSON. You can place tool calls anywhere in your reply (not only at the end).
The userscript only executes direct tool-name tags. Never use wrapper formats such as <invoke name="tool_name">...</invoke> or <tool_call>...</tool_call>.
The tag name MUST exactly match one of the available tool names.
Never output pseudo tool-call JSON such as {"tool":"name","arguments":{...}} in a Markdown code block. That is explanation text, not an executable call.
Never place executable tool XML in a thinking/reasoning section. Put tool XML in the final assistant answer content so the userscript can execute it.

### Available Tools

${TOOLS_PLACEHOLDER}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.

## Memory Saving Rules

You MUST call the memory_save tool when any of the following appears in the conversation:
- The user mentions their identity, profession, or role
- The user expresses a preference, habit, or way of working
- The user corrects how you answer or behave
- An important technical decision or architecture choice is made
- The user explicitly says "remember this", "note this down", "don't forget"

### Example

User: I'm a frontend developer, mostly React and TypeScript
Assistant reply:

Got it! React + TypeScript is a very common frontend stack. Ask me anything about it.

<memory_save>
{"type": "user", "name": "User role and stack", "content": "Frontend engineer, primarily React and TypeScript", "tags": ["frontend", "React", "TypeScript"]}
</memory_save>

### Rules
- You may call tools anywhere in your reply, not just at the end
- Tool calls are executed automatically and the result is returned to you
- Only save durably valuable information, not one-off Q&A content
- Do not re-save information already present in Existing Memories

`,
  systemThinking: `You have long-term memory. Existing memories:

${MEMORIES_PLACEHOLDER}

## Tools

You have access to a set of tools. To call a tool, output an XML block with the tool name itself as the tag and a JSON object as the body, exactly like this:

<memory_save>
{"type": "user", "name": "User role", "content": "Frontend developer", "tags": ["frontend"]}
</memory_save>

The JSON body MUST be valid JSON on its own. Do NOT add any other text inside the tags, only JSON.
The userscript only executes direct tool-name tags. Never use wrapper formats such as <invoke name="tool_name">...</invoke> or <tool_call>...</tool_call>.
The tag name MUST exactly match one of the available tool names.
Never output pseudo tool-call JSON such as {"tool":"name","arguments":{...}} in a Markdown code block. That is explanation text, not an executable call.
Never place executable tool XML in a thinking/reasoning section. Put tool XML in the final assistant answer content so the userscript can execute it.

### Available Tools

${TOOLS_PLACEHOLDER}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.

When the user reveals important durable information (identity, preferences, behavior corrections, key decisions), you MUST call the memory_save tool. You may call tools anywhere in your reply. Only save durably valuable information; do not re-save existing memories.

---

`,
  toolFormatReminder: `---
Tool call format reminder:
Available tool tag names: {names}
These listed tools are executable by the userscript.
To call a tool, use ONLY the direct XML tag whose name is the tool name, with valid JSON as the body.
Do not use <invoke name="...">, <tool_call>, Markdown code fences, {"tool":"...","arguments":{...}}, or any wrapper format.
Do not put executable tool XML in a thinking/reasoning section; put it in the final assistant answer content.
`,
  ui: {
    panelTitle: 'DeepSeek++ Memory & Personalization',
    tabMemories: 'Memories',
    tabPresets: 'System Prompt',
    tabSettings: 'Settings',
    tabAbout: 'About',
    searchPlaceholder: 'Search memories (name, content, tags)',
    addMemory: 'Add memory',
    editMemory: 'Edit memory',
    deleteMemory: 'Delete',
    pin: 'Pin',
    unpin: 'Unpin',
    save: 'Save',
    cancel: 'Cancel',
    name: 'Name',
    content: 'Content',
    tags: 'Tags (comma separated)',
    type: 'Type',
    scope: 'Scope',
    empty: 'No memories yet. The model saves important details automatically as you chat.',
    memoryEnabled: 'Enable memory injection',
    systemPromptEnabled: 'Enable system prompt injection',
    presetCadence: 'Preset injection cadence',
    cadenceDefault: 'Default (first + every 10)',
    cadenceFirst: 'First message only',
    cadenceEvery: 'Every message',
    cadenceOff: 'Off',
    forceLanguage: 'Force response language',
    languageAuto: 'Auto',
    languageZh: 'Simplified Chinese',
    languageEn: 'English',
    activePreset: 'Active',
    newPreset: 'New preset',
    presetName: 'Preset name',
    presetContent: 'Preset content',
    none: 'None',
    exportData: 'Export data',
    importData: 'Import data',
    archiveStale: 'Archive stale memories',
    stats: '{count} memories',
    savedToast: 'Saved',
    importedToast: 'Imported {count} memories',
    archivedToast: 'Archived {count} stale memories',
    confirmDelete: 'Delete this memory?',
    typeUser: 'Identity / preference',
    typeFeedback: 'Behavior correction',
    typeTopic: 'Discussion point',
    typeReference: 'Reference',
    memoryInjected: 'Injected {count} memories',
    memorySaved: 'Memory saved: {name}',
    memoryUpdated: 'Memory updated: {name}',
    memoryDeleted: 'Memory deleted {name}',
    openPanel: 'Open DeepSeek++ panel',
  },
};

const RESOURCES: Record<SupportedLocale, PromptMessages> = { 'zh-CN': zhCN, en };

export const DEFAULT_LOCALE: SupportedLocale = 'zh-CN';

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return value === 'zh-CN' || value === 'en';
}

export type MessageParams = Record<string, string | number>;

type PromptMessageKey = Exclude<keyof PromptMessages, 'ui'>;

export function translate(
  locale: SupportedLocale,
  key: PromptMessageKey,
  params?: MessageParams,
): string {
  const template = RESOURCES[locale]?.[key] ?? RESOURCES[DEFAULT_LOCALE][key];
  return interpolate(template, params);
}

export function translateUi(
  locale: SupportedLocale,
  key: string,
  params?: MessageParams,
): string {
  const template =
    RESOURCES[locale]?.ui[key] ?? RESOURCES[DEFAULT_LOCALE].ui[key] ?? key;
  return interpolate(template, params);
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** Resolves the browser language into a supported locale. */
export function detectLocale(): SupportedLocale {
  const language = (
    (typeof navigator !== 'undefined' && navigator.language) ||
    'zh-CN'
  ).toLowerCase();
  return language.startsWith('zh') ? 'zh-CN' : 'en';
}
