// ==UserScript==
// @name         DeepSeek++ 记忆与个性化
// @name:en      DeepSeek++ Memory & Personalization
// @namespace    https://github.com/zhu1090093659/deepseek-pp
// @version      1.14.0
// @description  为 DeepSeek 网页版添加跨对话长期记忆、系统提示词预设、项目上下文和 /skill 提示词片段（DeepSeek++ 浏览器扩展的油猴脚本移植版）
// @description:en  Long-term cross-conversation memory, system prompt presets, project context and /skill snippets for DeepSeek web (userscript port of the DeepSeek++ extension)
// @author       DeepSeek++ contributors
// @license      Apache-2.0
// @homepageURL  https://github.com/zhu1090093659/deepseek-pp
// @supportURL   https://github.com/zhu1090093659/deepseek-pp/issues
// @match        https://chat.deepseek.com/*
// @icon         https://chat.deepseek.com/favicon.svg
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// ==/UserScript==

"use strict";
(() => {
  // userscript/src/constants.ts
  var SCRIPT_NAME = "DeepSeek++ Userscript";
  var DEEPSEEK_WEB_ROUTES = {
    completion: "/api/v0/chat/completion",
    editMessage: "/api/v0/chat/edit_message",
    regenerate: "/api/v0/chat/regenerate",
    history: "/api/v0/chat/history_messages"
  };
  var MEMORY_TOKEN_BUDGET = 1500;
  var PRESET_REINJECTION_INTERVAL = 10;
  var STALE_THRESHOLD_DAYS = 90;
  var MIN_ACCESS_FOR_RETENTION = 3;
  var SKILL_TRIGGER_REGEX = /^\/(\S+)\s*([\s\S]*)$/;
  var STOP_WORDS = /* @__PURE__ */ new Set([
    "的",
    "了",
    "在",
    "是",
    "我",
    "有",
    "和",
    "就",
    "不",
    "人",
    "都",
    "一",
    "一个",
    "上",
    "也",
    "很",
    "到",
    "说",
    "要",
    "去",
    "你",
    "会",
    "着",
    "没有",
    "看",
    "好",
    "自己",
    "这",
    "他",
    "她",
    "它",
    "们",
    "那",
    "里",
    "之",
    "中",
    "与",
    "而",
    "为",
    "以",
    "及",
    "等",
    "被",
    "把",
    "让",
    "给",
    "从",
    "向",
    "对",
    "但",
    "如果",
    "因为",
    "所以",
    "虽然",
    "可以",
    "能",
    "想",
    "知道",
    "时候",
    "没",
    "什么",
    "怎么",
    "这个",
    "那个",
    "还",
    "过",
    "吗",
    "呢",
    "吧",
    "啊",
    "嗯",
    "哦",
    "呀",
    "啦",
    "使用",
    "the",
    "be",
    "to",
    "of",
    "and",
    "a",
    "in",
    "that",
    "have",
    "i",
    "it",
    "for",
    "not",
    "on",
    "with",
    "he",
    "as",
    "you",
    "do",
    "at",
    "this",
    "but",
    "his",
    "by",
    "from",
    "they",
    "we",
    "she",
    "or",
    "an",
    "will",
    "my",
    "one",
    "all",
    "would",
    "there",
    "their",
    "what",
    "so",
    "up",
    "out",
    "if",
    "about",
    "who",
    "get",
    "which",
    "go",
    "me",
    "when",
    "make",
    "can",
    "like",
    "no",
    "just",
    "him",
    "know",
    "take",
    "into",
    "your",
    "some",
    "could",
    "them",
    "than",
    "other",
    "been",
    "has",
    "its",
    "use",
    "two",
    "how",
    "our",
    "way"
  ]);

  // userscript/src/i18n.ts
  var TOOLS_PLACEHOLDER = "{tools}";
  var MEMORIES_PLACEHOLDER = "{memories}";
  var zhCN = {
    memoryEmpty: "(暂无记忆)",
    memoryDisabled: "(本次请求已关闭记忆注入)",
    standaloneMemories: `## 已有记忆
${MEMORIES_PLACEHOLDER}`,
    forceResponseLanguage: "## 回复语言\n请使用{language}回复。",
    responseLanguageChinese: "简体中文",
    responseLanguageEnglish: "英文",
    skillUserInputWrapper: "{instructions}\n\n---\n\n以下是用户本次的输入，请根据上述指令处理：\n\n{userInput}",
    projectContextHeader: "## 项目上下文",
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
      panelTitle: "DeepSeek++ 记忆与个性化",
      tabMemories: "记忆",
      tabPresets: "系统提示词",
      tabSettings: "设置",
      tabAbout: "关于",
      searchPlaceholder: "搜索记忆（标题、内容、标签）",
      addMemory: "新增记忆",
      editMemory: "编辑记忆",
      deleteMemory: "删除",
      pin: "置顶",
      unpin: "取消置顶",
      save: "保存",
      cancel: "取消",
      name: "标题",
      content: "内容",
      tags: "标签（逗号分隔）",
      type: "类型",
      scope: "范围",
      empty: "暂无记忆。与 DeepSeek 对话时，模型会自动保存重要信息。",
      memoryEnabled: "启用记忆注入",
      systemPromptEnabled: "启用系统提示词注入",
      presetCadence: "预设注入频率",
      cadenceDefault: "默认（首条 + 每 10 条）",
      cadenceFirst: "仅首条消息",
      cadenceEvery: "每条消息",
      cadenceOff: "关闭",
      forceLanguage: "强制回复语言",
      languageAuto: "自动",
      languageZh: "简体中文",
      languageEn: "English",
      activePreset: "当前启用",
      newPreset: "新建预设",
      presetName: "预设名称",
      presetContent: "预设内容",
      none: "无",
      exportData: "导出数据",
      importData: "导入数据",
      archiveStale: "清理陈旧记忆",
      stats: "共 {count} 条记忆",
      savedToast: "已保存",
      importedToast: "已导入 {count} 条记忆",
      archivedToast: "已清理 {count} 条陈旧记忆",
      confirmDelete: "确认删除这条记忆？",
      typeUser: "身份偏好",
      typeFeedback: "行为纠正",
      typeTopic: "讨论要点",
      typeReference: "参考资料",
      memoryInjected: "已注入 {count} 条记忆",
      memorySaved: "已保存记忆：{name}",
      memoryUpdated: "已更新记忆：{name}",
      memoryDeleted: "已删除记忆 {name}",
      openPanel: "打开 DeepSeek++ 面板"
    }
  };
  var en = {
    memoryEmpty: "(No memories yet)",
    memoryDisabled: "(Memory injection disabled for this request)",
    standaloneMemories: `## Existing Memories
${MEMORIES_PLACEHOLDER}`,
    forceResponseLanguage: "## Response Language\nReply in {language}.",
    responseLanguageChinese: "Simplified Chinese",
    responseLanguageEnglish: "English",
    skillUserInputWrapper: "{instructions}\n\n---\n\nThe following is the user input for this turn. Follow the instructions above when handling it:\n\n{userInput}",
    projectContextHeader: "## Project Context",
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
      panelTitle: "DeepSeek++ Memory & Personalization",
      tabMemories: "Memories",
      tabPresets: "System Prompt",
      tabSettings: "Settings",
      tabAbout: "About",
      searchPlaceholder: "Search memories (name, content, tags)",
      addMemory: "Add memory",
      editMemory: "Edit memory",
      deleteMemory: "Delete",
      pin: "Pin",
      unpin: "Unpin",
      save: "Save",
      cancel: "Cancel",
      name: "Name",
      content: "Content",
      tags: "Tags (comma separated)",
      type: "Type",
      scope: "Scope",
      empty: "No memories yet. The model saves important details automatically as you chat.",
      memoryEnabled: "Enable memory injection",
      systemPromptEnabled: "Enable system prompt injection",
      presetCadence: "Preset injection cadence",
      cadenceDefault: "Default (first + every 10)",
      cadenceFirst: "First message only",
      cadenceEvery: "Every message",
      cadenceOff: "Off",
      forceLanguage: "Force response language",
      languageAuto: "Auto",
      languageZh: "Simplified Chinese",
      languageEn: "English",
      activePreset: "Active",
      newPreset: "New preset",
      presetName: "Preset name",
      presetContent: "Preset content",
      none: "None",
      exportData: "Export data",
      importData: "Import data",
      archiveStale: "Archive stale memories",
      stats: "{count} memories",
      savedToast: "Saved",
      importedToast: "Imported {count} memories",
      archivedToast: "Archived {count} stale memories",
      confirmDelete: "Delete this memory?",
      typeUser: "Identity / preference",
      typeFeedback: "Behavior correction",
      typeTopic: "Discussion point",
      typeReference: "Reference",
      memoryInjected: "Injected {count} memories",
      memorySaved: "Memory saved: {name}",
      memoryUpdated: "Memory updated: {name}",
      memoryDeleted: "Memory deleted {name}",
      openPanel: "Open DeepSeek++ panel"
    }
  };
  var RESOURCES = { "zh-CN": zhCN, en };
  var DEFAULT_LOCALE = "zh-CN";
  function isSupportedLocale(value) {
    return value === "zh-CN" || value === "en";
  }
  function translate(locale, key, params) {
    const template = RESOURCES[locale]?.[key] ?? RESOURCES[DEFAULT_LOCALE][key];
    return interpolate(template, params);
  }
  function translateUi(locale, key, params) {
    const template = RESOURCES[locale]?.ui[key] ?? RESOURCES[DEFAULT_LOCALE].ui[key] ?? key;
    return interpolate(template, params);
  }
  function interpolate(template, params) {
    if (!params) return template;
    return template.replace(
      /\{(\w+)\}/g,
      (match, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    );
  }
  function detectLocale() {
    const language = (typeof navigator !== "undefined" && navigator.language || "zh-CN").toLowerCase();
    return language.startsWith("zh") ? "zh-CN" : "en";
  }

  // userscript/src/storage.ts
  function resolveGmApi() {
    const scope = globalThis;
    const getValue = scope.GM_getValue;
    const setValue = scope.GM_setValue;
    const deleteValue = scope.GM_deleteValue;
    const listValues = scope.GM_listValues;
    if (!getValue || !setValue) return null;
    return {
      getValue,
      setValue,
      deleteValue: deleteValue ?? (() => void 0),
      listValues: listValues ?? (() => [])
    };
  }
  var gm = resolveGmApi();
  function readRaw(key) {
    if (gm) {
      const value = gm.getValue(key);
      return typeof value === "string" ? value : null;
    }
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function writeRaw(key, value) {
    if (gm) {
      gm.setValue(key, value);
      return;
    }
    localStorage.setItem(key, value);
  }
  function removeRaw(key) {
    if (gm) {
      gm.deleteValue(key);
      return;
    }
    try {
      localStorage.removeItem(key);
    } catch {
    }
  }
  function readSlot(key) {
    const raw = readRaw(key);
    if (raw === null) return { present: false, value: void 0 };
    try {
      return { present: true, value: JSON.parse(raw) };
    } catch {
      throw new Error(`Storage slot ${key} is not valid JSON`);
    }
  }
  function writeSlot(key, value) {
    writeRaw(key, JSON.stringify(value));
  }
  function removeSlot(key) {
    removeRaw(key);
  }
  function createSerialQueue() {
    let tail = Promise.resolve();
    return function run(operation) {
      const result = tail.then(operation, operation);
      tail = result.catch(() => void 0);
      return result;
    };
  }
  function createRepository(options) {
    const queue2 = createSerialQueue();
    const readAlreadyQueued = () => {
      const slot = readSlot(options.key);
      if (!slot.present) return options.createDefault();
      return options.decode(slot.value);
    };
    return {
      read() {
        return queue2(readAlreadyQueued);
      },
      write(value) {
        return queue2(() => {
          readAlreadyQueued();
          writeSlot(options.key, options.decode(value));
        });
      },
      update(mutate) {
        return queue2(async () => {
          const current = readAlreadyQueued();
          const next = options.decode(await mutate(current));
          writeSlot(options.key, next);
          return next;
        });
      }
    };
  }

  // userscript/src/memory/codec.ts
  var MEMORY_TYPES = ["user", "feedback", "topic", "reference"];
  function decodePersistedMemoryRecord(value, path = "memory") {
    const object = objectValue(value, path);
    const id = positiveSafeInteger(object.id, `${path}.id`);
    return { ...decodeStoredMemory(object, path), id };
  }
  function decodeStoredMemory(value, path = "memory") {
    const object = objectValue(value, path);
    const scope = memoryScope(object.scope, `${path}.scope`);
    const { id: _id, projectId: _projectId, ...additiveFields } = object;
    return {
      ...additiveFields,
      syncId: nonEmptyString(object.syncId, `${path}.syncId`),
      scope,
      ...scope === "project" ? { projectId: nonEmptyString(object.projectId, `${path}.projectId`) } : {},
      type: enumValue(object.type, MEMORY_TYPES, `${path}.type`),
      name: nonEmptyString(object.name, `${path}.name`),
      content: nonEmptyString(object.content, `${path}.content`),
      description: stringValue(object.description, `${path}.description`),
      tags: stringArray(object.tags, `${path}.tags`),
      pinned: booleanValue(object.pinned, `${path}.pinned`),
      createdAt: finiteNumber(object.createdAt, `${path}.createdAt`),
      updatedAt: finiteNumber(object.updatedAt, `${path}.updatedAt`),
      accessCount: finiteNumber(object.accessCount, `${path}.accessCount`),
      lastAccessedAt: finiteNumber(object.lastAccessedAt, `${path}.lastAccessedAt`)
    };
  }
  function decodeImportedMemory(value, path = "memory") {
    const object = objectValue(value, path);
    const scope = object.scope === void 0 ? "global" : memoryScope(object.scope, `${path}.scope`);
    return {
      syncId: object.syncId === void 0 ? void 0 : nonEmptyString(object.syncId, `${path}.syncId`),
      scope,
      projectId: scope === "project" ? nonEmptyString(object.projectId, `${path}.projectId`) : void 0,
      type: enumValue(object.type, MEMORY_TYPES, `${path}.type`),
      name: nonEmptyString(object.name, `${path}.name`),
      content: nonEmptyString(object.content, `${path}.content`),
      description: object.description === void 0 ? "" : stringValue(object.description, `${path}.description`),
      tags: object.tags === void 0 ? [] : stringArray(object.tags, `${path}.tags`),
      pinned: object.pinned === void 0 ? false : booleanValue(object.pinned, `${path}.pinned`)
    };
  }
  function objectValue(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    return value;
  }
  function memoryScope(value, path) {
    if (value === "global" || value === "project") return value;
    throw new Error(`${path} must be global or project`);
  }
  function nonEmptyString(value, path) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${path} must be a non-empty string`);
    }
    return value;
  }
  function stringValue(value, path) {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    return value;
  }
  function booleanValue(value, path) {
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
    return value;
  }
  function finiteNumber(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number`);
    }
    return value;
  }
  function positiveSafeInteger(value, path) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${path} must be a positive safe integer`);
    }
    return value;
  }
  function stringArray(value, path) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`${path} must be a string array`);
    }
    return [...value];
  }
  function enumValue(value, allowed, path) {
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
    }
    return value;
  }

  // userscript/src/memory/store.ts
  var MEMORY_DATABASE_NAME = "DeepSeekPPUserscript";
  var MEMORY_DATABASE_VERSION = 1;
  var MEMORY_TABLE_NAME = "memories";
  var queue = createSerialQueue();
  var databasePromise = null;
  function openDatabase() {
    databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(MEMORY_DATABASE_NAME, MEMORY_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MEMORY_TABLE_NAME)) {
          const store = db.createObjectStore(MEMORY_TABLE_NAME, {
            keyPath: "id",
            autoIncrement: true
          });
          store.createIndex("syncId", "syncId", { unique: false });
          store.createIndex("type", "type", { unique: false });
          store.createIndex("pinned", "pinned", { unique: false });
          store.createIndex("scope", "scope", { unique: false });
          store.createIndex("projectId", "projectId", { unique: false });
          store.createIndex("lastAccessedAt", "lastAccessedAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked by another tab"));
    });
    return databasePromise;
  }
  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  }
  async function withStore(mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(MEMORY_TABLE_NAME, mode);
      const store = transaction.objectStore(MEMORY_TABLE_NAME);
      let result;
      let settled = false;
      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      transaction.onerror = () => {
        if (!settled) {
          settled = true;
          reject(transaction.error ?? new Error("IndexedDB transaction failed"));
        }
      };
      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
        }
      };
      operation(store).then(
        (value) => {
          result = value;
        },
        (error) => {
          settled = true;
          reject(error);
          try {
            transaction.abort();
          } catch {
          }
        }
      );
    });
  }
  async function readValidated(store) {
    const records = await promisifyRequest(store.getAll());
    return records.map((record, index) => decodePersistedMemoryRecord(record, `memories[${index}]`));
  }
  async function getAllMemories() {
    return withStore("readonly", readValidated);
  }
  async function getMemoryById(id) {
    const all = await getAllMemories();
    return all.find((memory) => memory.id === id);
  }
  async function saveMemory(memory) {
    const [id] = await importMemoriesAtomically([memory]);
    if (id === void 0) throw new Error("Memory save did not create a record");
    return id;
  }
  async function importMemoriesAtomically(memoriesToImport) {
    const validated = memoriesToImport.map(
      (memory, index) => decodeImportedMemory(memory, `memories[${index}]`)
    );
    return queue(
      () => withStore("readwrite", async (store) => {
        const current = await readValidated(store);
        const now = Date.now();
        const ids = [];
        const batchRows = /* @__PURE__ */ new Map();
        for (const memory of validated) {
          const syncId = memory.syncId ?? createSyncId();
          const existing = memory.syncId ? current.find((record2) => record2.syncId === memory.syncId) : void 0;
          if (existing?.id !== void 0) {
            const merged = { ...existing, ...memory, id: existing.id, syncId, updatedAt: now };
            await promisifyRequest(store.put(stripUndefined(merged)));
            ids.push(existing.id);
            continue;
          }
          if (memory.syncId) {
            const batchRow = batchRows.get(memory.syncId);
            if (batchRow?.id !== void 0) {
              const merged = {
                ...batchRow,
                ...memory,
                id: batchRow.id,
                syncId,
                updatedAt: now
              };
              await promisifyRequest(store.put(stripUndefined(merged)));
              batchRows.set(memory.syncId, merged);
              ids.push(batchRow.id);
              continue;
            }
          }
          const record = {
            ...memory,
            syncId,
            createdAt: now,
            updatedAt: now,
            accessCount: 0,
            lastAccessedAt: now
          };
          const key = await promisifyRequest(store.add(stripUndefined(record)));
          const numericId = key;
          if (memory.syncId) batchRows.set(memory.syncId, { ...record, id: numericId });
          ids.push(numericId);
        }
        return ids;
      })
    );
  }
  async function updateMemory(memory) {
    const validated = decodePersistedMemoryRecord(memory);
    await queue(
      () => withStore("readwrite", async (store) => {
        await readValidated(store);
        await promisifyRequest(
          store.put(stripUndefined({ ...validated, updatedAt: Date.now() }))
        );
      })
    );
  }
  async function deleteMemory(id) {
    await queue(
      () => withStore("readwrite", async (store) => {
        await readValidated(store);
        await promisifyRequest(store.delete(id));
      })
    );
  }
  async function touchMemories(ids) {
    if (ids.length === 0) return;
    await queue(
      () => withStore("readwrite", async (store) => {
        const current = await readValidated(store);
        const targetIds = new Set(ids);
        const now = Date.now();
        for (const memory of current) {
          if (memory.id === void 0 || !targetIds.has(memory.id)) continue;
          await promisifyRequest(
            store.put(
              stripUndefined({
                ...memory,
                accessCount: memory.accessCount + 1,
                lastAccessedAt: now
              })
            )
          );
        }
      })
    );
  }
  async function archiveStaleMemories() {
    return queue(
      () => withStore("readwrite", async (store) => {
        const threshold = Date.now() - STALE_THRESHOLD_DAYS * 864e5;
        const current = await readValidated(store);
        const ids = current.filter(
          (memory) => memory.lastAccessedAt < threshold && !memory.pinned && memory.accessCount < MIN_ACCESS_FOR_RETENTION
        ).map((memory) => memory.id).filter((id) => id !== void 0);
        for (const id of ids) {
          await promisifyRequest(store.delete(id));
        }
        return ids.length;
      })
    );
  }
  function createSyncId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    const random = Math.random().toString(16).slice(2);
    return `${Date.now().toString(16)}-${random}`;
  }
  function stripUndefined(value) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== void 0) result[key] = entry;
    }
    return result;
  }

  // userscript/src/preset/store.ts
  var PRESETS_STORAGE_KEY = "deepseek_pp_presets";
  var ACTIVE_PRESET_STORAGE_KEY = "deepseek_pp_active_preset_id";
  var PROJECTS_STORAGE_KEY = "deepseek_pp_projects";
  var ACTIVE_PROJECT_STORAGE_KEY = "deepseek_pp_active_project_id";
  function decodePreset(value, path = "preset") {
    const object = recordValue(value, path);
    return {
      ...object,
      id: requiredString(object.id, `${path}.id`),
      name: stringValue2(object.name, `${path}.name`),
      content: stringValue2(object.content, `${path}.content`),
      createdAt: finiteNumber2(object.createdAt, `${path}.createdAt`),
      updatedAt: finiteNumber2(object.updatedAt, `${path}.updatedAt`)
    };
  }
  function decodePresetCollection(value, path = "presets") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    return value.map((item, index) => decodePreset(item, `${path}[${index}]`));
  }
  var presetRepository = createRepository({
    key: PRESETS_STORAGE_KEY,
    createDefault: () => [],
    decode: (value) => decodePresetCollection(value)
  });
  function getAllPresets() {
    return presetRepository.read();
  }
  async function savePreset(preset) {
    const decoded = decodePreset(preset, "preset");
    await presetRepository.update((presets) => {
      const index = presets.findIndex((item) => item.id === decoded.id);
      const next = [...presets];
      if (index >= 0) next[index] = { ...next[index], ...decoded };
      else next.push(decoded);
      return next;
    });
  }
  async function deletePreset(id) {
    requireNonEmptyId(id, "Preset id");
    await presetRepository.update((presets) => presets.filter((preset) => preset.id !== id));
    if (getActivePresetId() === id) removeSlot(ACTIVE_PRESET_STORAGE_KEY);
  }
  function getActivePresetId() {
    const slot = readSlot(ACTIVE_PRESET_STORAGE_KEY);
    if (!slot.present) return null;
    if (typeof slot.value !== "string") {
      throw new Error("activePresetId must be a string");
    }
    return slot.value;
  }
  async function setActivePresetId(id) {
    if (id === null) {
      removeSlot(ACTIVE_PRESET_STORAGE_KEY);
      return;
    }
    requireNonEmptyId(id, "Preset id");
    const presets = await getAllPresets();
    if (!presets.some((preset) => preset.id === id)) {
      throw new Error(`Preset was not found: ${id}`);
    }
    writeSlot(ACTIVE_PRESET_STORAGE_KEY, id);
  }
  async function getActivePreset() {
    const activeId = getActivePresetId();
    if (!activeId) return null;
    const presets = await getAllPresets();
    return presets.find((preset) => preset.id === activeId) ?? null;
  }
  function decodeProject(value, path = "project") {
    const object = recordValue(value, path);
    return {
      ...object,
      id: requiredString(object.id, `${path}.id`),
      name: stringValue2(object.name, `${path}.name`),
      instructions: stringValue2(object.instructions, `${path}.instructions`),
      createdAt: finiteNumber2(object.createdAt, `${path}.createdAt`),
      updatedAt: finiteNumber2(object.updatedAt, `${path}.updatedAt`)
    };
  }
  var projectRepository = createRepository({
    key: PROJECTS_STORAGE_KEY,
    createDefault: () => [],
    decode: (value) => {
      if (!Array.isArray(value)) throw new Error("projects must be an array");
      return value.map((item, index) => decodeProject(item, `projects[${index}]`));
    }
  });
  function getAllProjects() {
    return projectRepository.read();
  }
  function getActiveProjectId() {
    const slot = readSlot(ACTIVE_PROJECT_STORAGE_KEY);
    if (!slot.present) return null;
    if (typeof slot.value !== "string") throw new Error("activeProjectId must be a string");
    return slot.value;
  }
  async function getActiveProject() {
    const activeId = getActiveProjectId();
    if (!activeId) return null;
    const projects = await getAllProjects();
    return projects.find((project) => project.id === activeId) ?? null;
  }
  function recordValue(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    return value;
  }
  function requiredString(value, path) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${path} must be a non-empty string`);
    }
    return value;
  }
  function stringValue2(value, path) {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    return value;
  }
  function finiteNumber2(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number`);
    }
    return value;
  }
  function requireNonEmptyId(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${label} is required`);
    }
  }

  // userscript/src/skill/store.ts
  var SKILLS_STORAGE_KEY = "deepseek_pp_user_skills";
  function decodeSkill(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    const object = value;
    const name = object.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`${path}.name must be a non-empty string`);
    }
    const instructions = object.instructions;
    if (typeof instructions !== "string") {
      throw new Error(`${path}.instructions must be a string`);
    }
    return {
      name,
      description: typeof object.description === "string" ? object.description : "",
      instructions,
      memoryEnabled: object.memoryEnabled !== false,
      enabled: object.enabled !== false,
      createdAt: typeof object.createdAt === "number" ? object.createdAt : Date.now(),
      updatedAt: typeof object.updatedAt === "number" ? object.updatedAt : Date.now()
    };
  }
  var repository = createRepository({
    key: SKILLS_STORAGE_KEY,
    createDefault: () => [],
    decode: (value) => {
      if (!Array.isArray(value)) throw new Error("skills must be an array");
      return value.map((item, index) => decodeSkill(item, `skills[${index}]`));
    }
  });
  function getAllSkills() {
    return repository.read();
  }
  async function getEnabledSkills() {
    return (await repository.read()).filter((skill) => skill.enabled);
  }
  async function saveSkill(skill, previousName) {
    const decoded = decodeSkill(skill, "skill");
    await repository.update((skills) => {
      const targetName = previousName ?? decoded.name;
      const index = skills.findIndex((item) => item.name === targetName);
      const next = [...skills];
      if (index >= 0) next[index] = { ...next[index], ...decoded, updatedAt: Date.now() };
      else next.push(decoded);
      return next;
    });
  }
  async function deleteSkill(name) {
    await repository.update((skills) => skills.filter((skill) => skill.name !== name));
  }

  // userscript/src/prompt/settings.ts
  var DEFAULT_PROMPT_INJECTION_SETTINGS = {
    memoryEnabled: true,
    systemPromptEnabled: true,
    presetCadence: "default",
    forceResponseLanguage: "auto",
    showActivityToasts: true,
    uiLocale: "auto"
  };
  var PROMPT_SETTINGS_STORAGE_KEY = "deepseek_pp_prompt_injection_settings";
  function normalizePromptInjectionSettings(value) {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      memoryEnabled: object.memoryEnabled !== false,
      systemPromptEnabled: object.systemPromptEnabled !== false,
      presetCadence: normalizePresetCadence(object.presetCadence),
      forceResponseLanguage: normalizeForcedLanguage(object.forceResponseLanguage),
      showActivityToasts: object.showActivityToasts !== false,
      uiLocale: normalizeUiLocale(object.uiLocale)
    };
  }
  var repository2 = createRepository({
    key: PROMPT_SETTINGS_STORAGE_KEY,
    createDefault: () => ({ ...DEFAULT_PROMPT_INJECTION_SETTINGS }),
    decode: normalizePromptInjectionSettings
  });
  function getPromptInjectionSettings() {
    return repository2.read();
  }
  function savePromptInjectionSettings(settings) {
    return repository2.update((current) => ({ ...current, ...settings }));
  }
  function shouldInjectPresetForTurn(input) {
    if (!input.hasActivePreset) return false;
    switch (input.cadence) {
      case "off":
        return false;
      case "first_message":
        return input.isFirstMessage;
      case "every_message":
        return true;
      case "default":
      default:
        return input.isFirstMessage || input.messageCount % PRESET_REINJECTION_INTERVAL === 0;
    }
  }
  function normalizePresetCadence(value) {
    return value === "first_message" || value === "every_message" || value === "off" || value === "default" ? value : DEFAULT_PROMPT_INJECTION_SETTINGS.presetCadence;
  }
  function normalizeForcedLanguage(value) {
    if (value === "auto") return "auto";
    return isSupportedLocale(value) ? value : DEFAULT_PROMPT_INJECTION_SETTINGS.forceResponseLanguage;
  }
  function normalizeUiLocale(value) {
    if (value === "auto") return "auto";
    return isSupportedLocale(value) ? value : DEFAULT_PROMPT_INJECTION_SETTINGS.uiLocale;
  }

  // userscript/src/memory/scope.ts
  function filterMemoriesByProjectScope(memories, projectId) {
    return memories.filter((memory) => {
      if (memory.scope === "project") {
        return Boolean(projectId && memory.projectId === projectId);
      }
      return memory.scope === void 0 || memory.scope === "global";
    });
  }

  // userscript/src/memory/selector.ts
  function estimateTokenUnits(text) {
    let tokens = 0;
    for (const char of text) {
      tokens += char.charCodeAt(0) > 127 ? 0.6 : 0.3;
    }
    return tokens;
  }
  function estimateTokens(text) {
    return Math.ceil(estimateTokenUnits(text));
  }
  var segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh-Hans", { granularity: "word" }) : null;
  var SEGMENT_CACHE_LIMIT = 1e3;
  var segmentCache = /* @__PURE__ */ new Map();
  function segmentText(text) {
    const cached = segmentCache.get(text);
    if (cached) return cached;
    const words = segmenter ? [...segmenter.segment(text)].filter((segment) => segment.isWordLike).map((segment) => segment.segment.toLowerCase()).filter((word) => word.length > 1 && !STOP_WORDS.has(word)) : text.toLowerCase().split(/[\s,，。！？；：、\-_/]+/).filter((word) => word.length > 1 && !STOP_WORDS.has(word));
    if (segmentCache.size >= SEGMENT_CACHE_LIMIT) {
      const firstKey = segmentCache.keys().next().value;
      if (firstKey !== void 0) segmentCache.delete(firstKey);
    }
    segmentCache.set(text, words);
    return words;
  }
  function keywordScore(promptWords, memory) {
    const promptSet = new Set(promptWords);
    let tagHits = 0;
    for (const tag of memory.tags) {
      const tagLower = tag.toLowerCase();
      if (tagLower.length > 1 && promptSet.has(tagLower)) tagHits++;
      for (const promptWord of promptWords) {
        if (promptWord.length > 2 && tagLower.includes(promptWord) && tagLower !== promptWord) {
          tagHits += 0.5;
        }
      }
    }
    const nameWords = segmentText(memory.name);
    let nameHits = 0;
    for (const word of nameWords) {
      if (promptSet.has(word)) nameHits++;
    }
    const contentWords = segmentText(memory.content);
    let contentHits = 0;
    for (const word of contentWords) {
      if (promptSet.has(word)) contentHits++;
    }
    return tagHits * 20 + nameHits * 15 + contentHits * 5;
  }
  function decayScore(memory) {
    const daysSinceAccess = (Date.now() - memory.lastAccessedAt) / 864e5;
    const freshness = Math.max(0, 10 - daysSinceAccess * 0.1);
    return Math.min(memory.accessCount, 20) + freshness;
  }
  function getMemoryBudget(promptTokens) {
    if (promptTokens > 3e3) {
      return Math.max(800, MEMORY_TOKEN_BUDGET - Math.floor((promptTokens - 3e3) * 0.2));
    }
    return MEMORY_TOKEN_BUDGET;
  }
  function selectMemories(prompt, allMemories, options) {
    if (allMemories.length === 0) return [];
    const { budget = MEMORY_TOKEN_BUDGET, identityOnly = false } = options ?? {};
    const candidates = identityOnly ? allMemories.filter(
      (memory) => memory.type === "user" || memory.type === "feedback" || memory.pinned
    ) : allMemories;
    if (candidates.length === 0) return [];
    const promptWords = segmentText(prompt);
    const scored = candidates.map((memory) => ({
      memory,
      score: (memory.pinned ? 1e3 : 0) + keywordScore(promptWords, memory) + decayScore(memory) + (Date.now() - memory.lastAccessedAt < 36e5 ? 5 : 0)
    }));
    scored.sort((left, right) => right.score - left.score);
    const selected = [];
    let remaining = budget;
    for (const { memory } of scored) {
      const cost = estimateTokens(formatMemoryLine(memory));
      if (remaining - cost < 0 && selected.length > 0) break;
      selected.push(memory);
      remaining -= cost;
    }
    return selected;
  }
  function sanitizeContent(text) {
    return text.replace(/｜DSML｜/g, "|DSML|");
  }
  function formatMemoryLine(memory) {
    const idPrefix = memory.id != null ? `#${memory.id} ` : "";
    const scopePrefix = memory.scope === "project" ? "project " : "";
    return `- ${idPrefix}[${scopePrefix}${memory.type}] ${sanitizeContent(memory.name)}: ${sanitizeContent(memory.content)}`;
  }
  function formatMemoriesBlock(memories, locale = "zh-CN") {
    if (memories.length === 0) return translate(locale, "memoryEmpty");
    return memories.map(formatMemoryLine).join("\n");
  }

  // userscript/src/prompt/visibility.ts
  var VISIBLE_USER_PROMPT_START = "<!-- deepseek-pp-visible-user-prompt:start -->";
  var VISIBLE_USER_PROMPT_END = "<!-- deepseek-pp-visible-user-prompt:end -->";
  var VISIBLE_USER_PROMPT_METADATA_PREFIX = "<!-- deepseek-pp-visible-user-prompt:value=";
  var VISIBLE_USER_PROMPT_METADATA_SUFFIX = " -->";
  var TOOL_REMINDER_HEADING_EN = "Tool call format reminder:";
  var TOOL_REMINDER_REQUIRED_LINE_EN = "Available tool tag names:";
  var TOOL_REMINDER_HEADING_ZH = "工具调用格式提醒：";
  var TOOL_REMINDER_REQUIRED_LINE_ZH = "可用工具标签名：";
  var TOOL_REMINDER_FRAGMENT_PREFIXES = [
    TOOL_REMINDER_HEADING_EN,
    TOOL_REMINDER_REQUIRED_LINE_EN,
    TOOL_REMINDER_HEADING_ZH,
    TOOL_REMINDER_REQUIRED_LINE_ZH,
    "These listed tools are executable by the userscript.",
    "To call a tool, use ONLY the direct XML tag",
    'Do not use <invoke name="...">',
    "Do not put executable tool XML",
    "这些工具已由用户脚本连接，可以执行。",
    "调用工具时，只能使用与工具名一致的直接 XML 标签",
    '不要使用 <invoke name="...">',
    "不要把可执行工具 XML"
  ];
  function markVisibleUserPrompt(prompt) {
    return `${VISIBLE_USER_PROMPT_START}
${prompt}
${VISIBLE_USER_PROMPT_END}`;
  }
  function markVisibleUserPromptMetadata(prompt) {
    return `${VISIBLE_USER_PROMPT_METADATA_PREFIX}${encodeURIComponent(JSON.stringify(prompt))}${VISIBLE_USER_PROMPT_METADATA_SUFFIX}`;
  }
  function extractVisibleUserPrompt(text) {
    const metadataPrompt = extractVisibleUserPromptMetadata(text);
    if (metadataPrompt !== null) return metadataPrompt;
    const start = text.indexOf(VISIBLE_USER_PROMPT_START);
    if (start === -1) return null;
    const contentStart = start + VISIBLE_USER_PROMPT_START.length;
    const end = text.indexOf(VISIBLE_USER_PROMPT_END, contentStart);
    if (end === -1) return null;
    return trimSingleBoundaryNewline(text.slice(contentStart, end));
  }
  function extractVisibleUserPromptMetadata(text) {
    const visiblePromptStart = text.indexOf(VISIBLE_USER_PROMPT_START);
    if (visiblePromptStart === -1 || text[visiblePromptStart - 1] !== "\n") return null;
    const metadataLineEnd = visiblePromptStart - 1;
    const metadataLineStart = text.lastIndexOf("\n", metadataLineEnd - 1) + 1;
    const metadataLine = text.slice(metadataLineStart, metadataLineEnd);
    if (!metadataLine.startsWith(VISIBLE_USER_PROMPT_METADATA_PREFIX) || !metadataLine.endsWith(VISIBLE_USER_PROMPT_METADATA_SUFFIX)) {
      return null;
    }
    const contentStart = VISIBLE_USER_PROMPT_METADATA_PREFIX.length;
    const contentEnd = metadataLine.length - VISIBLE_USER_PROMPT_METADATA_SUFFIX.length;
    try {
      const decoded = JSON.parse(decodeURIComponent(metadataLine.slice(contentStart, contentEnd)));
      return typeof decoded === "string" ? decoded : null;
    } catch {
      return null;
    }
  }
  function sanitizeInternalPromptText(text, fallbackVisiblePrompt) {
    const visiblePrompt = extractVisibleUserPrompt(text);
    if (visiblePrompt !== null) return visiblePrompt;
    if (isToolReminderOnly(text)) return "";
    if (containsToolFormatReminder(text)) {
      return fallbackVisiblePrompt ?? stripToolFormatReminder(text);
    }
    return text;
  }
  function trimSingleBoundaryNewline(text) {
    let next = text;
    if (next.startsWith("\r\n")) next = next.slice(2);
    else if (next.startsWith("\n")) next = next.slice(1);
    if (next.endsWith("\r\n")) next = next.slice(0, -2);
    else if (next.endsWith("\n")) next = next.slice(0, -1);
    return next;
  }
  function containsToolFormatReminder(text) {
    return text.includes(TOOL_REMINDER_HEADING_EN) && text.includes(TOOL_REMINDER_REQUIRED_LINE_EN) || text.includes(TOOL_REMINDER_HEADING_ZH) && text.includes(TOOL_REMINDER_REQUIRED_LINE_ZH);
  }
  function stripToolFormatReminder(text) {
    const headingIndex = [TOOL_REMINDER_HEADING_EN, TOOL_REMINDER_HEADING_ZH].map((heading) => text.indexOf(heading)).filter((index) => index !== -1).sort((left, right) => left - right)[0];
    if (headingIndex === void 0) return text;
    const delimiterIndex = text.lastIndexOf("\n---", headingIndex);
    const cutIndex = delimiterIndex === -1 ? headingIndex : delimiterIndex;
    return text.slice(0, cutIndex).trim();
  }
  function isToolReminderOnly(text) {
    const normalized = text.trimStart();
    if (!normalized) return false;
    return TOOL_REMINDER_FRAGMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }

  // userscript/src/tool/xml-tags.ts
  var PARTIAL_TAG_WHITESPACE_LIMIT = 8;
  function findFirstXmlToolTag(text, toolNames, options) {
    if (!text || toolNames.size === 0) return null;
    let searchFrom = Math.max(0, options.fromIndex ?? 0);
    let knownTagEnd = -1;
    while (searchFrom < text.length) {
      const index = text.indexOf("<", searchFrom);
      if (index === -1) return null;
      const tagEnd = knownTagEnd > index ? knownTagEnd : text.indexOf(">", index + 1);
      if (tagEnd === -1) return null;
      const parsed = parseCompleteXmlToolTag(text, index, tagEnd, toolNames);
      if (parsed && parsed.closing === options.closing) return parsed;
      const nextLt = text.indexOf("<", index + 1);
      if (nextLt !== -1 && nextLt < tagEnd) {
        knownTagEnd = tagEnd;
        searchFrom = nextLt;
      } else {
        knownTagEnd = -1;
        searchFrom = tagEnd + 1;
      }
    }
    return null;
  }
  function getPartialXmlToolTagTailLength(text, toolNames, options) {
    if (!text || toolNames.size === 0) return 0;
    const names = Array.from(toolNames);
    const maxNameLength = Math.max(0, ...names.map((name) => name.length));
    const limit = Math.min(text.length, 2 + maxNameLength + PARTIAL_TAG_WHITESPACE_LIMIT * 2);
    for (let length = limit; length > 0; length -= 1) {
      if (isPartialXmlToolTag(text.slice(-length), names, options.closing)) return length;
    }
    return 0;
  }
  function parseCompleteXmlToolTag(text, index, tagEnd, toolNames) {
    let cursor = index + 1;
    cursor = skipWhitespace(text, cursor, tagEnd);
    let closing = false;
    if (text[cursor] === "/") {
      closing = true;
      cursor += 1;
      cursor = skipWhitespace(text, cursor, tagEnd);
    }
    if (!isToolNameStart(text[cursor])) return null;
    const nameStart = cursor;
    cursor += 1;
    while (cursor < tagEnd && isToolNameChar(text[cursor])) {
      cursor += 1;
    }
    const name = text.slice(nameStart, cursor);
    if (!toolNames.has(name)) return null;
    cursor = skipWhitespace(text, cursor, tagEnd);
    if (cursor !== tagEnd) return null;
    return {
      index,
      endIndex: tagEnd + 1,
      name,
      raw: text.slice(index, tagEnd + 1),
      closing
    };
  }
  function isPartialXmlToolTag(value, toolNames, closing) {
    if (!value.startsWith("<")) return false;
    let cursor = 1;
    const beforeSlash = skipLimitedWhitespace(value, cursor);
    if (beforeSlash === value.length) return true;
    cursor = beforeSlash;
    if (value[cursor] === "/") {
      if (!closing) return false;
      cursor += 1;
      const beforeName = skipLimitedWhitespace(value, cursor);
      if (beforeName === value.length) return true;
      cursor = beforeName;
    } else if (closing) {
      return false;
    }
    if (!isToolNameStart(value[cursor])) return false;
    const nameStart = cursor;
    cursor += 1;
    while (cursor < value.length && isToolNameChar(value[cursor])) {
      cursor += 1;
    }
    const typedName = value.slice(nameStart, cursor);
    if (!toolNames.some((name) => name.startsWith(typedName))) return false;
    const afterName = skipLimitedWhitespace(value, cursor);
    return afterName === value.length;
  }
  function skipWhitespace(text, cursor, end) {
    while (cursor < end && isWhitespace(text[cursor])) {
      cursor += 1;
    }
    return cursor;
  }
  function skipLimitedWhitespace(text, cursor) {
    let count = 0;
    while (cursor < text.length && count < PARTIAL_TAG_WHITESPACE_LIMIT && isWhitespace(text[cursor])) {
      cursor += 1;
      count += 1;
    }
    return cursor;
  }
  function isWhitespace(value) {
    return value === " " || value === "\n" || value === "\r" || value === "	" || value === "\f";
  }
  function isToolNameStart(value) {
    return Boolean(value && /[A-Za-z_]/.test(value));
  }
  function isToolNameChar(value) {
    return Boolean(value && /[A-Za-z0-9_.:-]/.test(value));
  }
  function getToolCloseTag(name) {
    return `</${name}>`;
  }

  // userscript/src/tool/parser.ts
  function createToolInvocationCatalog(descriptors = []) {
    const byInvocationName = /* @__PURE__ */ new Map();
    for (const descriptor of descriptors) {
      byInvocationName.set(descriptor.invocationName, descriptor);
      if (!byInvocationName.has(descriptor.name)) {
        byInvocationName.set(descriptor.name, descriptor);
      }
    }
    return {
      descriptors,
      invocationNames: [...byInvocationName.keys()],
      byInvocationName
    };
  }
  var callSequence = 0;
  function createToolCallId() {
    callSequence += 1;
    return `dspp-${Date.now().toString(36)}-${callSequence}`;
  }
  function createToolParseError(code, invocationName, message) {
    return { code, message: `${invocationName}: ${message}`, retryable: false };
  }
  function createToolCallFromInvocation(invocationName, payload, raw, catalog, options) {
    const descriptor = catalog.byInvocationName.get(invocationName);
    return {
      id: createToolCallId(),
      name: descriptor?.name ?? invocationName,
      invocationName,
      descriptorId: descriptor?.id,
      payload,
      raw,
      ...options?.parseError ? { parseError: options.parseError } : {}
    };
  }
  function extractToolCalls(text, descriptors) {
    const catalog = createToolInvocationCatalog(descriptors);
    const calls = [];
    const names = catalog.invocationNames;
    if (names.length === 0 || !text) return calls;
    const nameSet = new Set(names);
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const open = findFirstXmlToolTag(text, nameSet, { closing: false, fromIndex });
      if (!open) break;
      const close = findFirstXmlToolTag(text, /* @__PURE__ */ new Set([open.name]), {
        closing: true,
        fromIndex: open.endIndex
      });
      if (!close) {
        fromIndex = open.endIndex;
        continue;
      }
      const raw = text.slice(open.index, close.endIndex);
      const body = text.slice(open.endIndex, close.index).trim();
      const invocationName = open.name;
      try {
        const parsed = body.length === 0 ? {} : JSON.parse(body);
        if (!isToolPayload(parsed)) {
          calls.push(
            createToolCallFromInvocation(invocationName, {}, raw, catalog, {
              parseError: createToolParseError(
                "tool_call_payload_invalid",
                invocationName,
                "Tool call body must be a JSON object."
              )
            })
          );
          fromIndex = close.endIndex;
          continue;
        }
        calls.push(createToolCallFromInvocation(invocationName, parsed, raw, catalog));
      } catch (error) {
        calls.push(
          createToolCallFromInvocation(invocationName, {}, raw, catalog, {
            parseError: createToolParseError(
              "tool_call_json_invalid",
              invocationName,
              [
                "Tool call body is not valid JSON.",
                "Use double quotes for strings.",
                error instanceof Error ? error.message : String(error)
              ].join(" ")
            )
          })
        );
      }
      fromIndex = close.endIndex;
    }
    return calls;
  }
  function stripToolCalls(text, descriptors) {
    const catalog = createToolInvocationCatalog(descriptors);
    const blocks = collectXmlToolCallBlocks(text, catalog);
    return removeBlocks(text, blocks).trim();
  }
  function hasToolCallMarker(text, descriptors) {
    const catalog = createToolInvocationCatalog(descriptors);
    const nameSet = new Set(catalog.invocationNames);
    if (nameSet.size === 0) return false;
    return Boolean(findFirstXmlToolTag(text, nameSet, { closing: false }));
  }
  function collectXmlToolCallBlocks(text, catalog) {
    const blocks = [];
    const nameSet = new Set(catalog.invocationNames);
    if (nameSet.size === 0 || !text) return blocks;
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const open = findFirstXmlToolTag(text, nameSet, { closing: false, fromIndex });
      if (!open) break;
      const close = findFirstXmlToolTag(text, /* @__PURE__ */ new Set([open.name]), {
        closing: true,
        fromIndex: open.endIndex
      });
      if (!close) {
        fromIndex = open.endIndex;
        continue;
      }
      blocks.push({ start: open.index, end: close.endIndex });
      fromIndex = close.endIndex;
    }
    return blocks;
  }
  function removeBlocks(text, blocks) {
    if (blocks.length === 0) return text;
    let result = "";
    let cursor = 0;
    for (const block of blocks) {
      result += text.slice(cursor, block.start);
      cursor = block.end;
    }
    result += text.slice(cursor);
    return result.replace(/\n{3,}/g, "\n\n");
  }
  function isToolPayload(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  // userscript/src/prompt/augmentation.ts
  function buildPromptAugmentation(originalPrompt, options) {
    const {
      memories = [],
      thinkingEnabled = false,
      identityOnly = false,
      presetContent = null,
      projectContext = null,
      locale = "zh-CN",
      memoryEnabled = true,
      systemPromptEnabled = true,
      forceResponseLanguage = null
    } = options ?? {};
    const toolDescriptors = options?.toolDescriptors ?? [];
    const visiblePromptMetadata = options?.visibleUserPrompt === void 0 ? "" : `${markVisibleUserPromptMetadata(options.visibleUserPrompt)}
`;
    const promptTokens = estimateTokens(originalPrompt);
    const budget = getMemoryBudget(promptTokens);
    const selected = memoryEnabled ? selectMemories(originalPrompt, memories, { budget, identityOnly }) : [];
    const memBlock = memoryEnabled ? formatMemoriesBlock(selected, locale) : translate(locale, "memoryDisabled");
    const toolsBlock = systemPromptEnabled ? renderToolSchemas(toolDescriptors) : "";
    const baseSystem = systemPromptEnabled ? translate(locale, thinkingEnabled ? "systemThinking" : "systemChat", {
      memories: memBlock,
      tools: toolsBlock
    }) : "";
    const standaloneMemories = !systemPromptEnabled && memoryEnabled ? translate(locale, "standaloneMemories", { memories: memBlock }) : "";
    const system = [
      baseSystem,
      standaloneMemories,
      renderProjectContext(projectContext, locale),
      renderForcedResponseLanguage(forceResponseLanguage, locale)
    ].filter(Boolean).join("\n\n");
    const presetPrefix = presetContent ? `${presetContent}

---

` : "";
    const toolReminder = systemPromptEnabled ? renderToolFormatReminder(toolDescriptors, locale) : "";
    const systemPrefix = system ? `${system}

` : "";
    return {
      augmented: presetPrefix + systemPrefix + visiblePromptMetadata + markVisibleUserPrompt(originalPrompt) + toolReminder,
      usedMemoryIds: selected.map((memory) => memory.id).filter((id) => typeof id === "number"),
      renderedToolCount: systemPromptEnabled ? toolDescriptors.length : 0
    };
  }
  function renderProjectContext(projectContext, locale) {
    const trimmed = typeof projectContext === "string" ? projectContext.trim() : "";
    if (!trimmed) return "";
    return `${translate(locale, "projectContextHeader")}
${trimmed}`;
  }
  function renderForcedResponseLanguage(forceResponseLanguage, locale) {
    if (!forceResponseLanguage) return "";
    const language = forceResponseLanguage === "en" ? translate(locale, "responseLanguageEnglish") : translate(locale, "responseLanguageChinese");
    return translate(locale, "forceResponseLanguage", { language });
  }
  function renderToolSchemas(descriptors) {
    return descriptors.map((descriptor) => renderToolSchema(descriptor)).join("\n\n");
  }
  function renderToolSchema(descriptor) {
    const examplePayload = createExamplePayload(descriptor);
    const name = descriptor.invocationName;
    return [
      `### Tool ${name}`,
      `Title: ${descriptor.title}`,
      `Description: ${descriptor.description}`,
      `Valid call format for ${name}:`,
      `<${name}>`,
      JSON.stringify(examplePayload, null, 2),
      `</${name}>`,
      `Invalid formats: <invoke name="${name}">...</invoke>, <tool_call>...</tool_call>`,
      `Parameters JSON Schema: ${JSON.stringify(descriptor.inputSchema)}`
    ].join("\n");
  }
  function renderToolFormatReminder(descriptors, locale) {
    const catalog = createToolInvocationCatalog(descriptors);
    const names = catalog.invocationNames;
    if (names.length === 0) return "";
    return `

${translate(locale, "toolFormatReminder", { names: names.join(", ") })}`;
  }
  function createExamplePayload(descriptor) {
    const properties = descriptor.inputSchema.properties ?? {};
    const required = descriptor.inputSchema.required ?? Object.keys(properties);
    const payload = {};
    for (const key of required) {
      payload[key] = exampleValue(properties[key]);
    }
    return payload;
  }
  function exampleValue(schema) {
    if (!schema || typeof schema !== "object") return "value";
    const value = schema;
    const type = value.type;
    if (Array.isArray(type)) return exampleValue({ ...value, type: type[0] });
    if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0];
    switch (type) {
      case "number":
      case "integer":
        return 0;
      case "boolean":
        return false;
      case "array":
        return [];
      case "object":
        return {};
      case "string":
      default:
        return "value";
    }
  }

  // userscript/src/prompt/request-augmentation.ts
  function augmentDecodedRequestBody(decodedBody, state2) {
    const body = { ...decodedBody };
    const originalPrompt = body.prompt;
    const locale = state2.locale;
    const thinkingEnabled = body.thinking_enabled === true;
    const isFirstMessage = body.parent_message_id === null || body.parent_message_id === void 0;
    const messageCount = isFirstMessage ? 1 : state2.messageCount + 1;
    const promptSettings = normalizePromptInjectionSettings(
      state2.promptSettings ?? DEFAULT_PROMPT_INJECTION_SETTINGS
    );
    const shouldInjectPreset = shouldInjectPresetForTurn({
      hasActivePreset: Boolean(state2.activePreset),
      isFirstMessage,
      messageCount,
      cadence: promptSettings.presetCadence
    });
    const presetContent = shouldInjectPreset ? state2.activePreset.content : null;
    const forceResponseLanguage = promptSettings.forceResponseLanguage === "auto" ? null : promptSettings.forceResponseLanguage;
    const scopedMemories = filterMemoriesByProjectScope(state2.memories, state2.projectId);
    const resolvedSkill = resolveSkill(state2.skills, originalPrompt, locale);
    if (resolvedSkill) {
      const { augmented: augmented2, usedMemoryIds: usedMemoryIds2 } = buildPromptAugmentation(resolvedSkill.combinedPrompt, {
        memories: scopedMemories,
        thinkingEnabled,
        identityOnly: !resolvedSkill.memoryEnabled,
        visibleUserPrompt: originalPrompt,
        presetContent,
        projectContext: state2.projectContext,
        toolDescriptors: state2.toolDescriptors,
        locale,
        memoryEnabled: promptSettings.memoryEnabled,
        systemPromptEnabled: promptSettings.systemPromptEnabled,
        forceResponseLanguage
      });
      body.prompt = augmented2;
      return {
        body: JSON.stringify(body),
        originalPrompt,
        usedMemoryIds: usedMemoryIds2,
        messageCount
      };
    }
    const { augmented, usedMemoryIds } = buildPromptAugmentation(originalPrompt, {
      memories: scopedMemories,
      thinkingEnabled,
      presetContent,
      projectContext: state2.projectContext,
      toolDescriptors: state2.toolDescriptors,
      locale,
      memoryEnabled: promptSettings.memoryEnabled,
      systemPromptEnabled: promptSettings.systemPromptEnabled,
      forceResponseLanguage
    });
    body.prompt = augmented;
    return {
      body: JSON.stringify(body),
      originalPrompt,
      usedMemoryIds,
      messageCount
    };
  }
  function parseSkillCommand(input) {
    const match = input.match(SKILL_TRIGGER_REGEX);
    if (!match) return null;
    return { skillName: match[1], args: match[2]?.trim() ?? "" };
  }
  function resolveSkill(skills, prompt, locale) {
    const invocation = parseSkillCommand(prompt);
    if (!invocation) return null;
    const skill = skills.find((item) => item.name === invocation.skillName);
    if (!skill) return null;
    return {
      combinedPrompt: invocation.args ? translate(locale, "skillUserInputWrapper", {
        instructions: skill.instructions,
        userInput: invocation.args
      }) : skill.instructions,
      memoryEnabled: skill.memoryEnabled,
      skillName: skill.name
    };
  }

  // userscript/src/deepseek/routes.ts
  var AUGMENTABLE_ROUTES = /* @__PURE__ */ new Set([
    "completion",
    "editMessage",
    "regenerate"
  ]);
  var ROUTE_METHODS = {
    completion: "POST",
    editMessage: "POST",
    regenerate: "POST",
    history: "GET"
  };
  function isAugmentableRoute(value) {
    return typeof value === "string" && AUGMENTABLE_ROUTES.has(value);
  }
  function matchDeepSeekRoute(input) {
    let pathname;
    try {
      pathname = new URL(input.url, input.baseUrl ?? location.href).pathname;
    } catch {
      return null;
    }
    const method = input.method.toUpperCase();
    for (const [name, path] of Object.entries(DEEPSEEK_WEB_ROUTES)) {
      if (pathname !== path) continue;
      if (ROUTE_METHODS[name] !== method) continue;
      return name;
    }
    return null;
  }
  function decodeDeepSeekRequestBody(bodyStr) {
    let value;
    try {
      value = JSON.parse(bodyStr);
    } catch {
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const body = value;
    if (typeof body.prompt !== "string" || body.prompt.length === 0) return null;
    return body;
  }

  // userscript/src/tool/memory-tools.ts
  var MEMORY_TYPES2 = ["user", "feedback", "topic", "reference"];
  var MEMORY_TOOL_NAMES = ["memory_save", "memory_update", "memory_delete"];
  function isMemoryToolName(name) {
    return MEMORY_TOOL_NAMES.includes(name);
  }
  var TYPE_DESCRIPTION = "Memory type: user=identity/role/preference, feedback=behavior correction, topic=discussion point, reference=external resource";
  function createMemoryToolDescriptors() {
    return [
      {
        id: "local:memory:memory_save",
        name: "memory_save",
        invocationName: "memory_save",
        title: "Save memory",
        description: "Save a new long-term memory about the user or the current work.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: MEMORY_TYPES2, description: TYPE_DESCRIPTION },
            name: { type: "string", description: "Short title" },
            content: { type: "string", description: "Content to remember" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tag list used for later retrieval"
            }
          },
          required: ["type", "name", "content", "tags"],
          additionalProperties: false
        }
      },
      {
        id: "local:memory:memory_update",
        name: "memory_update",
        invocationName: "memory_update",
        title: "Update memory",
        description: "Update an existing memory identified by its numeric id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "integer", description: "Memory id" },
            type: { type: "string", enum: MEMORY_TYPES2, description: TYPE_DESCRIPTION },
            name: { type: "string", description: "Updated title" },
            content: { type: "string", description: "Updated content" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tag list"
            }
          },
          required: ["id", "type", "name", "content", "tags"],
          additionalProperties: false
        }
      },
      {
        id: "local:memory:memory_delete",
        name: "memory_delete",
        invocationName: "memory_delete",
        title: "Delete memory",
        description: "Delete a memory identified by its numeric id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "integer", description: "Memory id" }
          },
          required: ["id"],
          additionalProperties: false
        }
      }
    ];
  }
  var defaultMemoryToolRuntime = {
    saveMemory,
    getMemoryById,
    updateMemory,
    deleteMemory
  };
  async function executeMemoryToolCall(call, locale, runtime = defaultMemoryToolRuntime) {
    if (call.parseError) {
      return failure(call, call.parseError.code, "Tool call format error", call.parseError.message, false);
    }
    if (call.name === "memory_save") return saveMemory2(runtime, call, locale);
    if (call.name === "memory_update") return updateExistingMemory(runtime, call, locale);
    if (call.name === "memory_delete") return deleteExistingMemory(runtime, call, locale);
    return failure(
      call,
      "memory_tool_unsupported",
      "Unsupported memory tool",
      `Unsupported memory tool: ${call.name}`,
      false
    );
  }
  async function saveMemory2(runtime, call, locale) {
    const parsed = parseMemorySavePayload(call);
    if (!parsed.ok) return parsed.result;
    const id = await runtime.saveMemory({
      type: parsed.memory.type,
      name: parsed.memory.name,
      content: parsed.memory.content,
      description: parsed.memory.name,
      tags: parsed.memory.tags,
      pinned: false
    });
    if (!id) {
      return failure(
        call,
        "memory_save_failed",
        "Memory save failed",
        "The memory store did not return a record id.",
        true
      );
    }
    return success(
      call,
      translateUi(locale, "memorySaved", { name: parsed.memory.name }),
      parsed.memory.name,
      { id }
    );
  }
  function parseMemorySavePayload(call) {
    const payload = call.payload;
    const type = memoryTypeValue(payload.type);
    if (!type) {
      return {
        ok: false,
        result: failure(call, "memory_invalid_payload", "Invalid payload", "type is invalid", false)
      };
    }
    const name = requiredStringValue(payload.name);
    if (!name) {
      return {
        ok: false,
        result: failure(call, "memory_invalid_payload", "Invalid payload", "name is invalid", false)
      };
    }
    const content = requiredStringValue(payload.content);
    if (!content) {
      return {
        ok: false,
        result: failure(call, "memory_invalid_payload", "Invalid payload", "content is invalid", false)
      };
    }
    if (!Array.isArray(payload.tags) || !payload.tags.every((item) => typeof item === "string")) {
      return {
        ok: false,
        result: failure(call, "memory_invalid_payload", "Invalid payload", "tags is invalid", false)
      };
    }
    return { ok: true, memory: { type, name, content, tags: [...payload.tags] } };
  }
  async function updateExistingMemory(runtime, call, locale) {
    const payload = call.payload;
    const id = numberValue(payload.id);
    if (!id) return failure(call, "memory_invalid_id", "Invalid memory id", void 0, false);
    const existing = await runtime.getMemoryById(id);
    if (!existing) {
      return failure(
        call,
        "memory_not_found",
        "Memory not found",
        `Memory #${id} does not exist.`,
        false
      );
    }
    const name = stringValue3(payload.name) || existing.name;
    await runtime.updateMemory({
      ...existing,
      type: memoryTypeValue(payload.type) || existing.type,
      name,
      content: stringValue3(payload.content) || existing.content,
      description: name || existing.description,
      tags: Array.isArray(payload.tags) ? stringArrayValue(payload.tags) : existing.tags
    });
    return success(call, translateUi(locale, "memoryUpdated", { name }), name);
  }
  async function deleteExistingMemory(runtime, call, locale) {
    const id = numberValue(call.payload.id);
    if (!id) return failure(call, "memory_invalid_id", "Invalid memory id", void 0, false);
    await runtime.deleteMemory(id);
    return success(call, translateUi(locale, "memoryDeleted", { name: `#${id}` }), `#${id}`);
  }
  function success(call, summary, detail, output) {
    return {
      ok: true,
      name: call.name,
      callId: call.id,
      descriptorId: call.descriptorId,
      summary,
      detail,
      output
    };
  }
  function failure(call, code, summary, detail, retryable) {
    return {
      ok: false,
      name: call.name,
      callId: call.id,
      descriptorId: call.descriptorId,
      summary,
      detail,
      error: { code, message: detail ?? summary, retryable }
    };
  }
  function stringValue3(value) {
    return typeof value === "string" ? value : "";
  }
  function requiredStringValue(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : "";
  }
  function numberValue(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  function memoryTypeValue(value) {
    return typeof value === "string" && MEMORY_TYPES2.includes(value) ? value : null;
  }
  function stringArrayValue(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  }

  // userscript/src/deepseek/sse.ts
  function createDeepSeekSseFrameDecoder() {
    let buffer = "";
    let scanFrom = 0;
    const drain = () => {
      const frames = [];
      const boundaryPattern = /\r?\n\r?\n/g;
      boundaryPattern.lastIndex = scanFrom;
      let offset = 0;
      let match;
      while ((match = boundaryPattern.exec(buffer)) !== null) {
        const separator = match[0];
        frames.push(createFrame(buffer.slice(offset, match.index), separator));
        offset = match.index + separator.length;
      }
      buffer = buffer.slice(offset);
      scanFrom = Math.max(0, buffer.length - 3);
      return frames;
    };
    return {
      push(text) {
        buffer += text;
        return drain();
      },
      finish() {
        const frames = drain();
        if (buffer.length > 0) {
          frames.push(createFrame(buffer, ""));
          buffer = "";
          scanFrom = 0;
        }
        return frames;
      }
    };
  }
  function createFrame(block, separator) {
    const event = parseSSEBlock(block);
    let parsedResolved = false;
    let parsed = null;
    return {
      block,
      separator,
      event,
      // Lazily parsed: most frames are forwarded untouched.
      get parsed() {
        if (!parsedResolved) {
          parsed = event ? parseSSEData(event.data) : null;
          parsedResolved = true;
        }
        return parsed;
      }
    };
  }
  function parseSSEBlock(block) {
    if (!block.trim()) return null;
    let id;
    let type = "message";
    const dataLines = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (rawLine.startsWith(":")) continue;
      const colonIndex = rawLine.indexOf(":");
      const field = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
      let value = colonIndex === -1 ? "" : rawLine.slice(colonIndex + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") id = value;
      else if (field === "event") type = value;
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) return null;
    return { ...id !== void 0 ? { id } : {}, type, data: dataLines.join("\n") };
  }
  function parseSSEData(data) {
    if (!data || data === "[DONE]") return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  function replaceSseFrameData(frame, data) {
    const lines = frame.block.split(/\r?\n/);
    const result = [];
    let dataWritten = false;
    for (const line of lines) {
      if (line.startsWith("data:")) {
        if (!dataWritten) {
          result.push(`data: ${data}`);
          dataWritten = true;
        }
        continue;
      }
      result.push(line);
    }
    if (!dataWritten) result.push(`data: ${data}`);
    return result.join("\n");
  }
  var RESPONSE_TEXT_PATHS = /* @__PURE__ */ new Set([
    "response/content",
    "response/fragments/-1/content",
    "response/fragments/-1/text"
  ]);
  function isResponseTextPatchPath(path) {
    if (typeof path !== "string") return false;
    if (RESPONSE_TEXT_PATHS.has(path)) return true;
    return /^response\/fragments\/-?\d+\/(content|text)$/.test(path);
  }
  function isBatchPatch(parsed) {
    return parsed?.o === "BATCH" && Array.isArray(parsed.v);
  }
  function isFragmentCreationPatch(parsed) {
    return typeof parsed?.p === "string" && parsed.p.endsWith("/fragments") && parsed.o === "APPEND" && Array.isArray(parsed.v);
  }
  function isResponsePatch(parsed) {
    if (!parsed || typeof parsed !== "object") return false;
    if (!parsed.p) return true;
    return typeof parsed.p === "string" && (parsed.p === "response" || parsed.p.startsWith("response/"));
  }
  function extractResponseTextFromParsed(parsed) {
    if (!parsed || typeof parsed !== "object") return null;
    if (isBatchPatch(parsed)) {
      const text = parsed.v.map((item) => extractResponseTextFromParsed(item)).filter((part) => part !== null).join("");
      return text.length > 0 ? text : null;
    }
    if (!parsed.p && typeof parsed.v === "string") return parsed.v;
    if (isResponseTextPatchPath(parsed.p) && parsed.o === "APPEND" && typeof parsed.v === "string") {
      return parsed.v;
    }
    if (isResponseTextPatchPath(parsed.p) && typeof parsed.v === "string" && !parsed.o) {
      return parsed.v;
    }
    if (isFragmentCreationPatch(parsed)) {
      const text = parsed.v.map((fragment) => extractFragmentText(fragment)).filter((part) => part !== null).join("");
      return text.length > 0 ? text : null;
    }
    return null;
  }
  function extractFragmentText(fragment) {
    if (!fragment || typeof fragment !== "object") return null;
    if (typeof fragment.content === "string") return fragment.content;
    if (typeof fragment.text === "string") return fragment.text;
    return null;
  }
  function getAnyDirectPatchText(parsed) {
    if (!parsed?.p && typeof parsed?.v === "string") return parsed.v;
    if (parsed?.p && parsed.o === "APPEND" && typeof parsed.v === "string") return parsed.v;
    if (typeof parsed?.p === "string" && typeof parsed.v === "string" && !parsed.o) {
      const lastSegment = parsed.p.split("/").pop();
      if (lastSegment === "content" || lastSegment === "text" || lastSegment === "markdown" || lastSegment === "delta") {
        return parsed.v;
      }
    }
    if (isFragmentCreationPatch(parsed)) {
      const parts = [];
      for (const fragment of parsed.v) {
        const text = extractFragmentText(fragment);
        if (text !== null) parts.push(text);
      }
      return parts.length > 0 ? parts.join("") : null;
    }
    return null;
  }
  function setAnyDirectPatchText(parsed, value) {
    if (!parsed?.p && typeof parsed?.v === "string") {
      parsed.v = value;
      return;
    }
    if (parsed?.p && parsed.o === "APPEND" && typeof parsed.v === "string") {
      parsed.v = value;
      return;
    }
    if (typeof parsed?.p === "string" && typeof parsed.v === "string" && !parsed.o) {
      parsed.v = value;
      return;
    }
    if (isFragmentCreationPatch(parsed)) {
      distributeFragmentText(parsed.v, value);
    }
  }
  function distributeFragmentText(fragments, value) {
    let remaining = value;
    for (let index = 0; index < fragments.length; index++) {
      const fragment = fragments[index];
      if (!fragment) continue;
      const key = typeof fragment.content === "string" ? "content" : typeof fragment.text === "string" ? "text" : null;
      if (!key) continue;
      if (index === fragments.length - 1) {
        fragment[key] = remaining;
      } else {
        const portion = remaining.slice(0, fragment[key].length);
        remaining = remaining.slice(fragment[key].length);
        fragment[key] = portion;
      }
    }
  }
  function cloneParsedWithTextSuffix(parsed, offset) {
    const text = extractResponseTextFromParsed(parsed);
    if (text === null) return null;
    if (offset <= 0) return parsed;
    if (offset >= text.length) return null;
    const cloned = JSON.parse(JSON.stringify(parsed));
    setResponseText(cloned, text.slice(offset));
    return cloned;
  }
  function cloneParsedWithTextPrefix(parsed, length) {
    const text = extractResponseTextFromParsed(parsed);
    if (text === null) return null;
    const cloned = JSON.parse(JSON.stringify(parsed));
    setResponseText(cloned, text.slice(0, Math.max(0, length)));
    return cloned;
  }
  function setResponseText(parsed, value) {
    if (isBatchPatch(parsed)) {
      let assigned = false;
      for (const item of parsed.v) {
        if (extractResponseTextFromParsed(item) === null) continue;
        setResponseText(item, assigned ? "" : value);
        assigned = true;
      }
      return;
    }
    setAnyDirectPatchText(parsed, value);
  }
  function createDeepSeekStreamSummary() {
    return { assistantText: "", responseMessageId: null, finished: false };
  }
  function consumeSseFrames(frames, summary, onParsed) {
    for (const frame of frames) {
      if (!frame.event || !frame.parsed) continue;
      const parsed = frame.parsed;
      if (isBatchPatch(parsed)) {
        for (const item of parsed.v) consumeParsed(item, summary);
      } else {
        consumeParsed(parsed, summary);
      }
      onParsed?.(frame.parsed, frame.event);
    }
  }
  function consumeParsed(parsed, summary) {
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.p === "response/message_id" && typeof parsed.v === "number") {
      summary.responseMessageId = parsed.v;
    }
    if (typeof parsed.v === "object" && parsed.v !== null && typeof parsed.v.message_id === "number") {
      summary.responseMessageId = parsed.v.message_id;
    }
    if (parsed.p === "response/status" && parsed.v === "FINISHED") summary.finished = true;
    if (parsed.finish_reason || parsed.v === "FINISHED") summary.finished = true;
  }

  // userscript/src/interceptor/stream-filter.ts
  var XmlToolStreamFilter = class {
    toolNames;
    visiblePrompt;
    state = "NORMAL";
    currentTool = null;
    pendingText = "";
    pendingBlocks = [];
    /** Drop leading blank lines from the text right after a stripped block. */
    stripTailLeadingNewlines = false;
    /** Whether the last emitted text ended with a newline (cross-frame state). */
    lastEmittedTextEndsWithNewline = false;
    constructor(descriptors = [], visiblePrompt = "") {
      this.visiblePrompt = visiblePrompt;
      this.toolNames = new Set(createToolInvocationCatalog(descriptors).invocationNames);
    }
    processFrames(frames, sink) {
      for (const frame of frames) {
        if (!frame.block.trim() || !frame.event || !frame.parsed) {
          sink.emit(frame.block, frame.separator);
          continue;
        }
        const sanitizedParsed = cloneParsedWithSanitizedInternalPrompt(
          frame.parsed,
          this.visiblePrompt
        );
        const effectiveParsed = sanitizedParsed ?? frame.parsed;
        const effectiveBlock = sanitizedParsed ? replaceSseFrameData(frame, JSON.stringify(sanitizedParsed)) : frame.block;
        const text = extractResponseTextFromParsed(effectiveParsed);
        if (text === null) {
          sink.emit(effectiveBlock, frame.separator);
          continue;
        }
        const isFragmentCreation = isFragmentCreationPatch(effectiveParsed);
        if (this.state === "SUPPRESSING") {
          const previousPendingLength = this.pendingText.length;
          const searchText = this.pendingText + text;
          const closeTag = this.findFirstToolClose(searchText, this.currentTool);
          if (closeTag) {
            const tailOffsetInCurrentText = closeTag.endIndex - previousPendingLength;
            const toolTail = this.getCurrentToolTail(
              effectiveParsed,
              text,
              isFragmentCreation,
              tailOffsetInCurrentText,
              frame
            );
            this.state = "NORMAL";
            this.pendingText = "";
            this.currentTool = null;
            this.stripTailLeadingNewlines = true;
            if (toolTail) {
              this.processNormalTextBlock(
                sink,
                toolTail.block,
                toolTail.separator,
                toolTail.sourceFrame,
                toolTail.parsed,
                toolTail.text,
                toolTail.isFragmentCreation
              );
            }
            continue;
          }
          this.pendingText = this.getCloseSearchTail(searchText, this.currentTool);
          if (isFragmentCreation || isBatchPatch(effectiveParsed)) {
            const modified = cloneParsedWithTextPrefix(effectiveParsed, 0);
            if (modified) {
              sink.emit(replaceSseFrameData(frame, JSON.stringify(modified)), frame.separator);
            }
          }
          continue;
        }
        this.processNormalTextBlock(
          sink,
          effectiveBlock,
          frame.separator,
          frame,
          effectiveParsed,
          text,
          isFragmentCreation
        );
      }
    }
    processNormalTextBlock(sink, block, separator, sourceFrame, parsed, text, isFragmentCreation) {
      if (this.stripTailLeadingNewlines) {
        const leadingNewlines = /^\n+/.exec(text);
        if (leadingNewlines) {
          const modified = cloneParsedWithTextSuffix(parsed, leadingNewlines[0].length);
          if (!modified) {
            return;
          }
          const modifiedText = extractResponseTextFromParsed(modified);
          if (!modifiedText) return;
          parsed = modified;
          text = modifiedText;
          block = replaceSseFrameData(sourceFrame, JSON.stringify(modified));
        }
        this.stripTailLeadingNewlines = false;
      }
      const previousPendingLength = this.pendingText.length;
      this.pendingText += text;
      this.pendingBlocks.push({ block, separator, sourceFrame, isFragmentCreation, parsed });
      const found = this.findFirstToolOpen(this.pendingText);
      if (found) {
        const closeTag = this.findFirstToolClose(this.pendingText, found.name, found.endIndex);
        const tailStart = closeTag ? closeTag.endIndex : -1;
        const tailOffsetInCurrentText = tailStart - previousPendingLength;
        let textBeforeOpen = this.pendingText.slice(0, found.index);
        const collapsedBeforeOpen = textBeforeOpen.replace(/\n{3,}$/, "\n\n");
        const openIdx = found.index - (textBeforeOpen.length - collapsedBeforeOpen.length);
        textBeforeOpen = collapsedBeforeOpen;
        this.stripTailLeadingNewlines = textBeforeOpen.length > 0 ? /\n$/.test(textBeforeOpen) : this.lastEmittedTextEndsWithNewline;
        this.emitBlocksBeforeOpen(sink, openIdx);
        this.pendingBlocks = [];
        if (!closeTag) {
          this.state = "SUPPRESSING";
          this.currentTool = found.name;
          this.pendingText = this.getCloseSearchTail(
            this.pendingText.slice(found.index),
            found.name
          );
          return;
        }
        this.state = "NORMAL";
        this.currentTool = null;
        this.pendingText = "";
        const toolTail = this.getCurrentToolTail(
          parsed,
          text,
          isFragmentCreation,
          tailOffsetInCurrentText,
          sourceFrame
        );
        if (toolTail) {
          this.processNormalTextBlock(
            sink,
            toolTail.block,
            toolTail.separator,
            toolTail.sourceFrame,
            toolTail.parsed,
            toolTail.text,
            toolTail.isFragmentCreation
          );
        }
        return;
      }
      if (this.couldBePartialToolOpen(this.pendingText)) return;
      for (const pending of this.pendingBlocks) {
        sink.emit(pending.block, pending.separator);
      }
      this.lastEmittedTextEndsWithNewline = /\n$/.test(this.pendingText);
      this.pendingBlocks = [];
      this.pendingText = "";
    }
    /**
     * Emits buffered frames up to `openIdx`, truncating the frame that contains
     * the open tag so its pre-tag text is preserved.
     */
    emitBlocksBeforeOpen(sink, openIdx) {
      let consumed = 0;
      for (const pending of this.pendingBlocks) {
        const pendingText = extractResponseTextFromParsed(pending.parsed) ?? "";
        const blockStart = consumed;
        const blockEnd = consumed + pendingText.length;
        consumed = blockEnd;
        if (blockEnd <= openIdx) {
          sink.emit(pending.block, pending.separator);
          continue;
        }
        if (blockStart >= openIdx) {
          if (pending.isFragmentCreation || isBatchPatch(pending.parsed)) {
            const modified2 = cloneParsedWithTextPrefix(pending.parsed, 0);
            if (modified2) {
              sink.emit(
                replaceSseFrameData(pending.sourceFrame, JSON.stringify(modified2)),
                pending.separator
              );
            }
          }
          continue;
        }
        const keepLength = openIdx - blockStart;
        const modified = cloneParsedWithTextPrefix(pending.parsed, keepLength);
        if (modified) {
          sink.emit(
            replaceSseFrameData(pending.sourceFrame, JSON.stringify(modified)),
            pending.separator
          );
        }
      }
    }
    getCurrentToolTail(parsed, text, isFragmentCreation, tailOffsetInCurrentText, sourceFrame) {
      if (tailOffsetInCurrentText >= text.length) return null;
      const modified = cloneParsedWithTextSuffix(parsed, Math.max(0, tailOffsetInCurrentText));
      if (!modified) return null;
      const modifiedText = extractResponseTextFromParsed(modified);
      if (!modifiedText) return null;
      return {
        block: replaceSseFrameData(sourceFrame, JSON.stringify(modified)),
        separator: sourceFrame.separator,
        sourceFrame,
        parsed: modified,
        text: modifiedText,
        isFragmentCreation: isFragmentCreation || isFragmentCreationPatch(modified)
      };
    }
    findFirstToolOpen(text) {
      return findFirstXmlToolTag(text, this.toolNames, { closing: false });
    }
    findFirstToolClose(text, tool, fromIndex = 0) {
      return findFirstXmlToolTag(text, /* @__PURE__ */ new Set([tool]), { closing: true, fromIndex });
    }
    couldBePartialToolOpen(text) {
      return getPartialXmlToolTagTailLength(text, this.toolNames, { closing: false }) > 0;
    }
    getCloseSearchTail(text, tool) {
      const tailLength = getPartialXmlToolTagTailLength(text, /* @__PURE__ */ new Set([tool]), { closing: true });
      return tailLength > 0 ? text.slice(-tailLength) : "";
    }
    flush(sink) {
      for (const pending of this.pendingBlocks) {
        sink.emit(pending.block, pending.separator);
      }
      this.pendingBlocks = [];
      this.pendingText = "";
    }
  };
  function cloneParsedWithSanitizedInternalPrompt(parsed, visiblePrompt) {
    const cloned = JSON.parse(JSON.stringify(parsed));
    let changed = false;
    const apply = (node) => {
      if (!node || typeof node !== "object") return;
      if (isBatchPatch(node)) {
        for (const item of node.v) apply(item);
        return;
      }
      const text = getAnyDirectPatchText(node);
      if (text === null) return;
      const isResponseText = isResponsePatch(node);
      const sanitized = sanitizeInternalPromptText(
        text,
        isResponseText ? void 0 : visiblePrompt
      );
      if (sanitized === text) return;
      setAnyDirectPatchText(node, isResponseText ? "" : sanitized);
      changed = true;
    };
    apply(cloned);
    return changed ? cloned : null;
  }

  // userscript/src/interceptor/history-cleanup.ts
  function stripToolCallsFromHistory(json, options) {
    if (!json || !json.data) return;
    const data = json.data.biz_data || json.data;
    const messages = data.chat_messages;
    if (!Array.isArray(messages)) return;
    cleanMessages(messages, options.toolDescriptors);
  }
  function stripToolCallsFromIDBResult(result, options) {
    if (Array.isArray(result)) {
      for (const item of result) cleanSingleIdbRecord(item, options.toolDescriptors);
      return;
    }
    cleanSingleIdbRecord(result, options.toolDescriptors);
  }
  function cleanSingleIdbRecord(record, toolDescriptors) {
    if (!record || !record.data) return;
    const messages = record.data.chat_messages;
    if (!Array.isArray(messages)) return;
    cleanMessages(messages, toolDescriptors);
  }
  function cleanMessages(messages, toolDescriptors) {
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      if (typeof message.content === "string") {
        message.content = sanitizeInternalPromptText(message.content);
      }
      sanitizeFragments(message.fragments);
      if (typeof message.content === "string" && hasToolCallMarker(message.content, toolDescriptors)) {
        message.content = stripToolCalls(message.content, toolDescriptors);
      }
      stripFragmentToolCalls(message.fragments, toolDescriptors);
    }
  }
  function sanitizeFragments(fragments) {
    if (!Array.isArray(fragments)) return;
    for (const fragment of fragments) {
      if (!fragment || typeof fragment !== "object") continue;
      if (typeof fragment.content === "string") {
        fragment.content = sanitizeInternalPromptText(fragment.content);
      }
    }
  }
  function stripFragmentToolCalls(fragments, toolDescriptors) {
    if (!Array.isArray(fragments)) return;
    const textFragments = fragments.filter(
      (fragment) => fragment && typeof fragment.content === "string"
    );
    if (textFragments.length === 0) return;
    const responseFragments = textFragments.filter(
      (fragment) => typeof fragment.type === "string" && fragment.type.toUpperCase() === "RESPONSE"
    );
    const thinkFragments = textFragments.filter(
      (fragment) => !(typeof fragment.type === "string" && fragment.type.toUpperCase() === "RESPONSE")
    );
    if (responseFragments.length > 0) {
      stripFragmentGroup(thinkFragments, toolDescriptors);
      stripFragmentGroup(responseFragments, toolDescriptors);
      return;
    }
    stripFragmentGroup(textFragments, toolDescriptors);
  }
  function stripFragmentGroup(fragments, toolDescriptors) {
    if (fragments.length === 0) return;
    const text = fragments.map((fragment) => fragment.content).join("");
    if (!hasToolCallMarker(text, toolDescriptors)) return;
    const stripped = stripToolCalls(text, toolDescriptors);
    fragments[0].content = stripped;
    for (let index = 1; index < fragments.length; index++) {
      fragments[index].content = "";
    }
  }

  // userscript/src/tool/streaming-text.ts
  function createStreamingToolTextAccumulator(descriptors) {
    return new ToolTextAccumulator(createToolInvocationCatalog(descriptors).invocationNames);
  }
  var ToolTextAccumulator = class {
    toolNames;
    state = "NORMAL";
    currentTool = null;
    pendingNormal = "";
    pendingSuppressed = "";
    visibleText = "";
    constructor(invocationNames) {
      this.toolNames = new Set(invocationNames);
    }
    append(chunk) {
      if (!chunk || this.toolNames.size === 0) {
        this.visibleText += chunk;
        return this.visibleText;
      }
      let remaining = chunk;
      while (remaining.length > 0) {
        remaining = this.state === "SUPPRESSING" ? this.consumeSuppressedText(remaining) : this.consumeNormalText(remaining);
      }
      return this.visibleText;
    }
    flush() {
      if (this.state === "NORMAL" && this.pendingNormal) {
        this.visibleText += this.pendingNormal;
      }
      this.state = "NORMAL";
      this.currentTool = null;
      this.pendingNormal = "";
      this.pendingSuppressed = "";
      return this.visibleText;
    }
    getVisibleText() {
      return this.visibleText;
    }
    consumeNormalText(input) {
      const text = this.pendingNormal + input;
      this.pendingNormal = "";
      const found = findFirstXmlToolTag(text, this.toolNames, { closing: false });
      if (!found) {
        const tailLength = getPartialXmlToolTagTailLength(text, this.toolNames, {
          closing: false
        });
        const emitLength = text.length - tailLength;
        if (emitLength > 0) this.visibleText += text.slice(0, emitLength);
        this.pendingNormal = tailLength > 0 ? text.slice(-tailLength) : "";
        return "";
      }
      if (found.index > 0) this.visibleText += text.slice(0, found.index);
      this.state = "SUPPRESSING";
      this.currentTool = found.name;
      this.pendingSuppressed = "";
      return text.slice(found.endIndex);
    }
    consumeSuppressedText(input) {
      const tool = this.currentTool;
      if (!tool) {
        this.state = "NORMAL";
        return input;
      }
      const text = this.pendingSuppressed + input;
      this.pendingSuppressed = "";
      const closeMatch = findFirstXmlToolTag(text, /* @__PURE__ */ new Set([tool]), { closing: true });
      if (!closeMatch) {
        const tailLength = getPartialXmlToolTagTailLength(text, /* @__PURE__ */ new Set([tool]), {
          closing: true
        });
        this.pendingSuppressed = tailLength > 0 ? text.slice(-tailLength) : "";
        return "";
      }
      this.state = "NORMAL";
      this.currentTool = null;
      return text.slice(closeMatch.endIndex ?? closeMatch.index + getToolCloseTag(tool).length);
    }
  };
  function createToolCallScanGate(descriptors) {
    const catalog = createToolInvocationCatalog(descriptors);
    const toolNames = new Set(catalog.invocationNames);
    let tail = "";
    return {
      shouldScanChunk(text) {
        if (!text || toolNames.size === 0) return false;
        const probe = tail + text;
        const tailLength = getPartialXmlToolTagTailLength(probe, toolNames, { closing: true });
        tail = tailLength > 0 ? probe.slice(-tailLength) : "";
        return Boolean(findFirstXmlToolTag(probe, toolNames, { closing: true }));
      }
    };
  }

  // userscript/src/interceptor/network-hook.ts
  var FETCH_HOOK_MARKER = /* @__PURE__ */ Symbol.for("dspp-userscript-fetch-hook");
  var XHR_HOOK_MARKER = /* @__PURE__ */ Symbol.for("dspp-userscript-xhr-hook");
  var IDB_HOOK_MARKER = /* @__PURE__ */ Symbol.for("dspp-userscript-idb-hook");
  var hookState = {
    toolDescriptors: [],
    onRequestBody: async () => null,
    onToolCall: () => void 0,
    onResponseComplete: () => void 0
  };
  var INITIAL_STATE_WAIT_MS = 3e3;
  var initialStateReady = false;
  var resolveInitialState = null;
  var initialStatePromise = new Promise((resolve) => {
    resolveInitialState = resolve;
  });
  function updateHookState(partial) {
    hookState = { ...hookState, ...partial };
    if (Object.prototype.hasOwnProperty.call(partial, "toolDescriptors")) {
      initialStateReady = true;
      resolveInitialState?.();
    }
  }
  async function waitForInitialState() {
    if (initialStateReady) return;
    let timeoutId;
    await Promise.race([
      initialStatePromise,
      new Promise((resolve) => {
        timeoutId = setTimeout(resolve, INITIAL_STATE_WAIT_MS);
      })
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    initialStateReady = true;
  }
  var requestSequence = 0;
  function createRequestId() {
    requestSequence += 1;
    return `req-${Date.now().toString(36)}-${requestSequence}`;
  }
  function installHook(name, install) {
    try {
      return install();
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] ${name} hook unavailable, feature degraded`, error);
      return null;
    }
  }
  function installNetworkHooks() {
    const cleanups = [];
    for (const [name, install] of [
      ["fetch", hookFetch],
      ["XHR", hookXhr],
      ["IndexedDB", hookIndexedDb]
    ]) {
      const cleanup = installHook(name, install);
      if (cleanup) cleanups.push(cleanup);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }
  function hookFetch() {
    const currentFetch = window.fetch;
    if (typeof currentFetch !== "function") return () => void 0;
    if (currentFetch[FETCH_HOOK_MARKER]) return () => void 0;
    const originalFetch = currentFetch;
    const hookedFetch = async function(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : null;
      const method = init?.method !== void 0 ? init.method : input instanceof Request ? input.method : "GET";
      const route = url !== null && typeof method === "string" ? matchDeepSeekRoute({ url, method, baseUrl: document.baseURI }) : null;
      if (route === "history") {
        return interceptHistoryResponse(originalFetch.call(this, input, init));
      }
      if (!isAugmentableRoute(route) || typeof init?.body !== "string") {
        return originalFetch.call(this, input, init);
      }
      await waitForInitialState();
      const requestId = createRequestId();
      const fallbackDescriptors = [...hookState.toolDescriptors];
      let modified = null;
      let augmentationFailed = false;
      try {
        modified = await hookState.onRequestBody(init.body, requestId);
      } catch (error) {
        augmentationFailed = true;
        console.error("[DeepSeek++] request augmentation failed; sending original request", error);
      }
      const requestBody = modified?.body ?? init.body;
      const executableDescriptors = augmentationFailed ? [] : fallbackDescriptors;
      const context = {
        requestId,
        originalPrompt: modified?.originalPrompt ?? "",
        toolDescriptors: executableDescriptors,
        filterToolDescriptors: augmentationFailed ? fallbackDescriptors : executableDescriptors
      };
      const requestInit = modified ? { ...init, body: modified.body } : init;
      return interceptStreamingResponse(
        originalFetch.call(this, input, requestInit),
        context
      );
    };
    Object.defineProperty(hookedFetch, FETCH_HOOK_MARKER, { value: true, configurable: true });
    try {
      window.fetch = hookedFetch;
    } catch {
      Object.defineProperty(window, "fetch", {
        value: hookedFetch,
        writable: true,
        configurable: true
      });
    }
    return () => {
      if (window.fetch !== hookedFetch) return;
      try {
        window.fetch = originalFetch;
      } catch {
        Object.defineProperty(window, "fetch", {
          value: originalFetch,
          writable: true,
          configurable: true
        });
      }
    };
  }
  async function interceptStreamingResponse(responsePromise, context) {
    let response;
    try {
      response = await responsePromise;
    } catch (error) {
      throw error;
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const streamState = createStreamState(context);
    let cancelled = false;
    let finished = false;
    const stream = new ReadableStream(
      {
        async pull(controller) {
          if (cancelled || finished) return;
          try {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (!done) {
              streamState.append(decoder.decode(value, { stream: true }), controller);
              return;
            }
            const finalText = decoder.decode();
            if (finalText) streamState.append(finalText, controller);
            streamState.finish(controller);
            finished = true;
            controller.close();
          } catch (error) {
            cancelled = true;
            try {
              await reader.cancel(error);
            } finally {
              controller.error(error);
            }
          }
        },
        async cancel(reason) {
          if (cancelled || finished) return;
          cancelled = true;
          await reader.cancel(reason);
        }
      },
      { highWaterMark: 0 }
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  function createStreamState(context) {
    const frameDecoder = createDeepSeekSseFrameDecoder();
    const summary = createDeepSeekStreamSummary();
    const filter = new XmlToolStreamFilter(context.filterToolDescriptors, context.originalPrompt);
    const accumulator = createStreamingToolTextAccumulator(context.toolDescriptors);
    const scanGate = createToolCallScanGate(context.toolDescriptors);
    const encoder = new TextEncoder();
    const dispatchedCallRaw = /* @__PURE__ */ new Set();
    let rawToolText = "";
    let completed = false;
    const createSink = (controller) => ({
      emit(block, separator) {
        controller.enqueue(encoder.encode(block + separator));
      }
    });
    const processFrames = (frames, controller) => {
      if (frames.length === 0) return;
      consumeSseFrames(frames, summary, (parsed) => {
        const text = extractTextForTools(parsed);
        if (!text) return;
        accumulator.append(text);
        rawToolText += text;
        if (!scanGate.shouldScanChunk(text)) return;
        for (const call of extractToolCalls(rawToolText, context.toolDescriptors)) {
          if (dispatchedCallRaw.has(call.raw)) continue;
          dispatchedCallRaw.add(call.raw);
          hookState.onToolCall(call);
        }
      });
      filter.processFrames(frames, createSink(controller));
    };
    return {
      append(text, controller) {
        processFrames(frameDecoder.push(text), controller);
      },
      finish(controller) {
        if (completed) return;
        completed = true;
        processFrames(frameDecoder.finish(), controller);
        filter.flush(createSink(controller));
        const visibleText = accumulator.flush();
        hookState.onResponseComplete({ requestId: context.requestId, text: visibleText });
      }
    };
  }
  function extractTextForTools(parsed) {
    const value = parsed;
    if (!value || typeof value !== "object") return null;
    if (value.o === "BATCH" && Array.isArray(value.v)) {
      const text = value.v.map((item) => extractTextForTools(item)).filter((part) => part !== null).join("");
      return text.length > 0 ? text : null;
    }
    if (typeof value.v === "string" && (!value.p || typeof value.p === "string")) {
      return value.v;
    }
    if (Array.isArray(value.v)) {
      const parts = [];
      for (const item of value.v) {
        if (item && typeof item === "object") {
          const fragment = item;
          if (typeof fragment.content === "string") parts.push(fragment.content);
          else if (typeof fragment.text === "string") parts.push(fragment.text);
        }
      }
      return parts.length > 0 ? parts.join("") : null;
    }
    return null;
  }
  async function interceptHistoryResponse(responsePromise) {
    const response = await responsePromise;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) return response;
    try {
      const json = await response.clone().json();
      stripToolCallsFromHistory(json, { toolDescriptors: hookState.toolDescriptors });
      return new Response(JSON.stringify(json), {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
      });
    } catch {
      return response;
    }
  }
  function hookXhr() {
    const ctor = globalThis.XMLHttpRequest;
    if (typeof ctor !== "function") return () => void 0;
    const prototype = ctor.prototype;
    if (prototype[XHR_HOOK_MARKER]) return () => void 0;
    const xhrRoutes = /* @__PURE__ */ new WeakMap();
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      const routeUrl = typeof url === "string" ? url : url instanceof URL ? url.href : null;
      const route = typeof method === "string" && routeUrl !== null ? matchDeepSeekRoute({ method, url: routeUrl, baseUrl: document.baseURI }) : null;
      xhrRoutes.set(this, route);
      return origOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(body) {
      const route = xhrRoutes.get(this);
      if (isAugmentableRoute(route) && typeof body === "string") {
        const xhr = this;
        const sendChatRequest = async () => {
          const requestId = createRequestId();
          const fallbackDescriptors = [...hookState.toolDescriptors];
          let modified = null;
          let augmentationFailed = false;
          try {
            modified = await hookState.onRequestBody(body, requestId);
          } catch (error) {
            augmentationFailed = true;
            console.error("[DeepSeek++] XHR augmentation failed; sending original request", error);
          }
          const requestBody = modified?.body ?? body;
          const executableDescriptors = augmentationFailed ? [] : fallbackDescriptors;
          setupXhrResponseInterceptor(xhr, {
            requestId,
            originalPrompt: modified?.originalPrompt ?? "",
            toolDescriptors: executableDescriptors,
            filterToolDescriptors: augmentationFailed ? fallbackDescriptors : executableDescriptors
          });
          return origSend.call(xhr, requestBody);
        };
        void waitForInitialState().then(sendChatRequest).catch((error) => console.error("[DeepSeek++] intercepted XHR request failed", error));
        return;
      }
      if (route === "history") setupXhrHistoryInterceptor(this);
      return origSend.call(this, body);
    };
    const hookedOpen = prototype.open;
    const hookedSend = prototype.send;
    Object.defineProperty(prototype, XHR_HOOK_MARKER, { value: true, configurable: true });
    return () => {
      if (prototype.open === hookedOpen) prototype.open = origOpen;
      if (prototype.send === hookedSend) prototype.send = origSend;
      delete prototype[XHR_HOOK_MARKER];
    };
  }
  function setupXhrResponseInterceptor(xhr, context) {
    let lastLen = 0;
    let filteredResponse = "";
    const streamState = createStreamState(context);
    let responseFinished = false;
    const origResponseTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText") || Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(XMLHttpRequest.prototype),
      "responseText"
    );
    const fakeController = {
      enqueue(data) {
        filteredResponse += new TextDecoder().decode(data);
      }
    };
    const consumeAvailableResponse = () => {
      const raw = origResponseTextDesc?.get?.call(xhr) || "";
      const newData = raw.slice(lastLen);
      lastLen = raw.length;
      if (newData) streamState.append(newData, fakeController);
    };
    const finishResponse = () => {
      if (responseFinished) return;
      consumeAvailableResponse();
      streamState.finish(fakeController);
      responseFinished = true;
    };
    const finishSuccessfulResponse = () => {
      if (xhr.readyState === 4 && xhr.status !== 0) finishResponse();
    };
    xhr.addEventListener("readystatechange", () => {
      if (xhr.readyState === 3 || xhr.readyState === 4) {
        consumeAvailableResponse();
        finishSuccessfulResponse();
      }
    });
    xhr.addEventListener("load", () => finishResponse(), { once: true });
    Object.defineProperty(xhr, "responseText", {
      get() {
        if (xhr.readyState === 3 || xhr.readyState === 4) consumeAvailableResponse();
        finishSuccessfulResponse();
        return filteredResponse;
      },
      configurable: true
    });
    Object.defineProperty(xhr, "response", {
      get() {
        if (xhr.responseType === "" || xhr.responseType === "text") {
          if (xhr.readyState === 3 || xhr.readyState === 4) consumeAvailableResponse();
          finishSuccessfulResponse();
          return filteredResponse;
        }
        return void 0;
      },
      configurable: true
    });
  }
  function setupXhrHistoryInterceptor(xhr) {
    const origResponseTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText") || Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(XMLHttpRequest.prototype),
      "responseText"
    );
    if (!origResponseTextDesc?.get) return;
    let cleanedText = null;
    const cleanResponse = () => {
      if (cleanedText !== null) return cleanedText;
      const raw = String(origResponseTextDesc.get.call(xhr) || "");
      if (xhr.readyState !== 4) return raw;
      let cleaned;
      try {
        const json = JSON.parse(raw);
        stripToolCallsFromHistory(json, { toolDescriptors: hookState.toolDescriptors });
        cleaned = JSON.stringify(json);
      } catch {
        cleaned = raw;
      }
      cleanedText = cleaned;
      return cleaned;
    };
    Object.defineProperty(xhr, "responseText", {
      get: cleanResponse,
      configurable: true
    });
    Object.defineProperty(xhr, "response", {
      get() {
        if (xhr.responseType === "" || xhr.responseType === "text") return cleanResponse();
        return void 0;
      },
      configurable: true
    });
  }
  function hookIndexedDb() {
    const ctor = globalThis.IDBObjectStore;
    if (typeof ctor !== "function") return () => void 0;
    const prototype = ctor.prototype;
    if (prototype[IDB_HOOK_MARKER]) return () => void 0;
    const origGet = prototype.get;
    const origGetAll = prototype.getAll;
    prototype.get = function(...args) {
      const request = origGet.apply(this, args);
      if (this.name === "history-message") patchIdbRequest(request);
      return request;
    };
    prototype.getAll = function(...args) {
      const request = origGetAll.apply(this, args);
      if (this.name === "history-message") patchIdbRequest(request);
      return request;
    };
    const hookedGet = prototype.get;
    const hookedGetAll = prototype.getAll;
    Object.defineProperty(prototype, IDB_HOOK_MARKER, { value: true, configurable: true });
    return () => {
      if (prototype.get === hookedGet) prototype.get = origGet;
      if (prototype.getAll === hookedGetAll) prototype.getAll = origGetAll;
      delete prototype[IDB_HOOK_MARKER];
    };
  }
  function patchIdbRequest(request) {
    const origResultDesc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result");
    if (!origResultDesc?.get) return;
    let cleaned = false;
    Object.defineProperty(request, "result", {
      get() {
        const result = origResultDesc.get.call(this);
        if (result && !cleaned) {
          cleaned = true;
          try {
            stripToolCallsFromIDBResult(result, {
              toolDescriptors: hookState.toolDescriptors
            });
          } catch (error) {
            console.error("[DeepSeek++] history cleanup failed", error);
          }
        }
        return result;
      },
      configurable: true
    });
  }

  // userscript/src/ui/styles.ts
  var PANEL_STYLES = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }

.dspp-fab {
  position: fixed;
  right: 20px;
  bottom: 96px;
  z-index: 2147483000;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: linear-gradient(135deg, #4d6bfe, #3b5bdb);
  color: #fff;
  font-size: 18px;
  font-weight: 600;
  box-shadow: 0 6px 20px rgba(77, 107, 254, 0.35);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.dspp-fab:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(77,107,254,.45); }
.dspp-fab:active { transform: translateY(0); }

.dspp-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483100;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dspp-overlay[hidden] { display: none; }

.dspp-panel {
  width: min(880px, 100%);
  max-height: min(760px, 92vh);
  display: flex;
  flex-direction: column;
  background: var(--dspp-bg, #ffffff);
  color: var(--dspp-fg, #1f2937);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.dspp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--dspp-border, #e5e7eb);
}
.dspp-title { font-size: 15px; font-weight: 650; }
.dspp-close {
  border: none; background: transparent; cursor: pointer;
  font-size: 20px; line-height: 1; color: var(--dspp-muted, #6b7280); padding: 4px 8px;
  border-radius: 6px;
}
.dspp-close:hover { background: var(--dspp-hover, #f3f4f6); }

.dspp-tabs { display: flex; gap: 4px; padding: 10px 16px 0; border-bottom: 1px solid var(--dspp-border,#e5e7eb); }
.dspp-tab {
  border: none; background: transparent; cursor: pointer;
  padding: 8px 14px; font-size: 13px; border-radius: 8px 8px 0 0;
  color: var(--dspp-muted, #6b7280);
}
.dspp-tab:hover { background: var(--dspp-hover, #f3f4f6); }
.dspp-tab.is-active { color: var(--dspp-accent, #4d6bfe); font-weight: 600; background: var(--dspp-hover, #f3f4f6); }

.dspp-body { flex: 1; overflow-y: auto; padding: 16px 20px 20px; }

.dspp-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.dspp-search { flex: 1; min-width: 200px; }

input[type="text"], input[type="search"], textarea, select {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  color: inherit;
  background: var(--dspp-input-bg, #fff);
  border: 1px solid var(--dspp-border, #d1d5db);
  border-radius: 8px;
  outline: none;
}
input:focus, textarea:focus, select:focus { border-color: var(--dspp-accent, #4d6bfe); }
textarea { resize: vertical; min-height: 90px; line-height: 1.5; }

.dspp-btn {
  border: 1px solid var(--dspp-border, #d1d5db);
  background: var(--dspp-input-bg, #fff);
  color: inherit;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.dspp-btn:hover { background: var(--dspp-hover, #f3f4f6); }
.dspp-btn.is-primary { background: var(--dspp-accent, #4d6bfe); border-color: var(--dspp-accent,#4d6bfe); color: #fff; }
.dspp-btn.is-primary:hover { filter: brightness(1.05); }
.dspp-btn.is-danger { color: #dc2626; }
.dspp-btn.is-small { padding: 4px 8px; font-size: 12px; }

.dspp-list { display: flex; flex-direction: column; gap: 10px; }
.dspp-card {
  border: 1px solid var(--dspp-border, #e5e7eb);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--dspp-card-bg, #fff);
}
.dspp-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dspp-card-name { font-weight: 600; font-size: 13px; flex: 1; word-break: break-word; }
.dspp-card-content { font-size: 13px; line-height: 1.55; color: var(--dspp-fg,#374151); white-space: pre-wrap; word-break: break-word; }
.dspp-card-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; align-items: center; }
.dspp-card-actions { display: flex; gap: 6px; }

.dspp-badge {
  font-size: 11px; padding: 2px 7px; border-radius: 999px;
  background: var(--dspp-hover, #f3f4f6); color: var(--dspp-muted, #6b7280);
}
.dspp-badge.is-pinned { background: #fef3c7; color: #92400e; }
.dspp-badge.is-user { background: #dbeafe; color: #1e40af; }
.dspp-badge.is-feedback { background: #fee2e2; color: #991b1b; }
.dspp-badge.is-topic { background: #dcfce7; color: #166534; }
.dspp-badge.is-reference { background: #ede9fe; color: #5b21b6; }

.dspp-empty { text-align: center; color: var(--dspp-muted, #6b7280); font-size: 13px; padding: 40px 16px; }
.dspp-stats { font-size: 12px; color: var(--dspp-muted, #6b7280); margin-bottom: 10px; }

.dspp-field { margin-bottom: 12px; }
.dspp-field label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 5px; color: var(--dspp-muted,#6b7280); }
.dspp-row { display: flex; gap: 10px; }
.dspp-row > * { flex: 1; }

.dspp-switch { display: flex; align-items: center; gap: 10px; padding: 10px 0; font-size: 13px; }
.dspp-switch input { width: auto; }
.dspp-switch-label { flex: 1; }

.dspp-form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }

.dspp-toast-host {
  position: fixed;
  right: 20px;
  bottom: 150px;
  z-index: 2147483200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
}
.dspp-toast {
  background: rgba(17, 24, 39, 0.92);
  color: #fff;
  font-size: 12.5px;
  padding: 8px 14px;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,.24);
  animation: dspp-toast-in .18s ease;
  max-width: 320px;
  word-break: break-word;
}
@keyframes dspp-toast-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.dspp-hint { font-size: 12px; color: var(--dspp-muted,#6b7280); line-height: 1.6; }
.dspp-hint code {
  background: var(--dspp-hover,#f3f4f6); padding: 1px 5px; border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
}

/* Dark theme: DeepSeek sets data-theme / prefers-color-scheme. */
:host([data-theme="dark"]) .dspp-panel,
:host([data-theme="dark"]) .dspp-card {
  --dspp-bg: #1f2023;
  --dspp-fg: #e5e7eb;
  --dspp-muted: #9ca3af;
  --dspp-border: #383a40;
  --dspp-hover: #2b2d31;
  --dspp-card-bg: #26282c;
  --dspp-input-bg: #1a1b1e;
}
:host([data-theme="dark"]) .dspp-panel { background: #1f2023; color: #e5e7eb; }
`;

  // userscript/src/ui/dom.ts
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      const { class: className, text, on, attrs, ...rest } = props;
      if (className) node.className = className;
      if (text !== void 0) node.textContent = text;
      for (const [key, value] of Object.entries(rest)) {
        if (value === void 0 || value === null) continue;
        node[key] = value;
      }
      for (const [key, value] of Object.entries(attrs ?? {})) {
        node.setAttribute(key, value);
      }
      for (const [event, handler] of Object.entries(on ?? {})) {
        node.addEventListener(event, handler);
      }
    }
    for (const child of children ?? []) {
      if (child === null || child === void 0 || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function formatTimestamp(value) {
    if (!Number.isFinite(value)) return "";
    const date = new Date(value);
    const pad = (input) => String(input).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  function pickJsonFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            resolve(JSON.parse(String(reader.result)));
          } catch {
            resolve(null);
          }
        };
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      });
      input.click();
    });
  }

  // userscript/src/ui/toast.ts
  var TOAST_VISIBLE_MS = 2600;
  var host = null;
  function createToastHost(root) {
    const element = document.createElement("div");
    element.className = "dspp-toast-host";
    root.appendChild(element);
    host = element;
  }
  function showToast(message) {
    if (!host || !message) return;
    const toast = document.createElement("div");
    toast.className = "dspp-toast";
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, TOAST_VISIBLE_MS);
  }

  // userscript/src/ui/panel.ts
  var HOST_ID = "dspp-userscript-host";
  function mountPanel(options) {
    document.getElementById(HOST_ID)?.remove();
    const host2 = document.createElement("div");
    host2.id = HOST_ID;
    const root = host2.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_STYLES;
    root.appendChild(style);
    (document.body ?? document.documentElement).appendChild(host2);
    const t = (key, params) => translateUi(options.locale, key, params);
    createToastHost(root);
    syncTheme(host2);
    let activeTab = "memories";
    let memoryQuery = "";
    let editingMemory = null;
    let creatingMemory = false;
    let editingPreset = null;
    let creatingPreset = false;
    let editingSkill = null;
    let creatingSkill = false;
    const bodyEl = el("div", { class: "dspp-body" });
    const tabsEl = el("div", { class: "dspp-tabs" });
    const panel2 = el("div", { class: "dspp-panel" }, [
      el("div", { class: "dspp-header" }, [
        el("div", { class: "dspp-title", text: t("panelTitle") }),
        el("button", {
          class: "dspp-close",
          text: "×",
          attrs: { "aria-label": "Close" },
          on: { click: () => controller.close() }
        })
      ]),
      tabsEl,
      bodyEl
    ]);
    const overlay = el("div", { class: "dspp-overlay", hidden: true }, [panel2]);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) controller.close();
    });
    root.appendChild(overlay);
    const fab = el("button", {
      class: "dspp-fab",
      text: "M+",
      attrs: { title: t("openPanel"), "aria-label": t("openPanel") },
      on: { click: () => controller.toggle() }
    });
    root.appendChild(fab);
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !overlay.hidden) controller.close();
    };
    document.addEventListener("keydown", onKeyDown);
    function renderTabs() {
      clear(tabsEl);
      const tabs = [
        ["memories", t("tabMemories")],
        ["presets", t("tabPresets")],
        ["skills", "Skills"],
        ["settings", t("tabSettings")]
      ];
      for (const [id, label] of tabs) {
        tabsEl.appendChild(
          el("button", {
            class: `dspp-tab${activeTab === id ? " is-active" : ""}`,
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
              }
            }
          })
        );
      }
    }
    async function render() {
      renderTabs();
      clear(bodyEl);
      try {
        if (activeTab === "memories") await renderMemories();
        else if (activeTab === "presets") await renderPresets();
        else if (activeTab === "skills") await renderSkills();
        else await renderSettings();
      } catch (error) {
        bodyEl.appendChild(
          el("div", {
            class: "dspp-empty",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          })
        );
      }
    }
    async function renderMemories() {
      if (creatingMemory || editingMemory) {
        bodyEl.appendChild(renderMemoryForm(editingMemory));
        return;
      }
      const memories = await getAllMemories();
      const query = memoryQuery.trim().toLowerCase();
      const filtered = query ? memories.filter(
        (memory) => memory.name.toLowerCase().includes(query) || memory.content.toLowerCase().includes(query) || memory.tags.some((tag) => tag.toLowerCase().includes(query))
      ) : memories;
      filtered.sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        return right.lastAccessedAt - left.lastAccessedAt;
      });
      const searchInput = el("input", {
        class: "dspp-search",
        type: "search",
        value: memoryQuery,
        attrs: { placeholder: t("searchPlaceholder") }
      });
      searchInput.addEventListener("input", () => {
        memoryQuery = searchInput.value;
        void render().then(() => {
          const next = bodyEl.querySelector(".dspp-search");
          next?.focus();
          next?.setSelectionRange(next.value.length, next.value.length);
        });
      });
      bodyEl.appendChild(
        el("div", { class: "dspp-toolbar" }, [
          searchInput,
          el("button", {
            class: "dspp-btn is-primary",
            text: t("addMemory"),
            on: {
              click: () => {
                creatingMemory = true;
                void render();
              }
            }
          }),
          el("button", {
            class: "dspp-btn",
            text: t("exportData"),
            on: { click: () => void exportAll() }
          }),
          el("button", {
            class: "dspp-btn",
            text: t("importData"),
            on: { click: () => void importAll() }
          }),
          el("button", {
            class: "dspp-btn",
            text: t("archiveStale"),
            on: {
              click: async () => {
                const count = await archiveStaleMemories();
                showToast(t("archivedToast", { count }));
                await options.onStateChanged();
                await render();
              }
            }
          })
        ])
      );
      bodyEl.appendChild(
        el("div", { class: "dspp-stats", text: t("stats", { count: memories.length }) })
      );
      if (filtered.length === 0) {
        bodyEl.appendChild(el("div", { class: "dspp-empty", text: t("empty") }));
        return;
      }
      const list = el("div", { class: "dspp-list" });
      for (const memory of filtered) list.appendChild(renderMemoryCard(memory));
      bodyEl.appendChild(list);
    }
    function renderMemoryCard(memory) {
      return el("div", { class: "dspp-card" }, [
        el("div", { class: "dspp-card-head" }, [
          el("span", { class: "dspp-card-name", text: memory.name }),
          el("span", {
            class: `dspp-badge is-${memory.type}`,
            text: t(memoryTypeLabelKey(memory.type))
          }),
          memory.pinned && el("span", { class: "dspp-badge is-pinned", text: "★" })
        ]),
        el("div", { class: "dspp-card-content", text: memory.content }),
        el("div", { class: "dspp-card-meta" }, [
          ...memory.tags.map((tag) => el("span", { class: "dspp-badge", text: tag })),
          el("span", {
            class: "dspp-badge",
            text: `#${memory.id} · ${formatTimestamp(memory.updatedAt)} · ×${memory.accessCount}`
          }),
          el("span", { style: "flex:1" }),
          el("div", { class: "dspp-card-actions" }, [
            el("button", {
              class: "dspp-btn is-small",
              text: memory.pinned ? t("unpin") : t("pin"),
              on: {
                click: async () => {
                  await updateMemory({ ...memory, pinned: !memory.pinned });
                  await options.onStateChanged();
                  await render();
                }
              }
            }),
            el("button", {
              class: "dspp-btn is-small",
              text: t("editMemory"),
              on: {
                click: () => {
                  editingMemory = memory;
                  void render();
                }
              }
            }),
            el("button", {
              class: "dspp-btn is-small is-danger",
              text: t("deleteMemory"),
              on: {
                click: async () => {
                  if (!confirm(t("confirmDelete"))) return;
                  if (memory.id === void 0) return;
                  await deleteMemory(memory.id);
                  await options.onStateChanged();
                  await render();
                }
              }
            })
          ])
        ])
      ]);
    }
    function renderMemoryForm(memory) {
      const nameInput = el("input", {
        type: "text",
        value: memory?.name ?? ""
      });
      const contentInput = el("textarea", {
        value: memory?.content ?? ""
      });
      const tagsInput = el("input", {
        type: "text",
        value: (memory?.tags ?? []).join(", ")
      });
      const typeSelect = el("select", {}, [
        ...["user", "feedback", "topic", "reference"].map(
          (type) => el("option", {
            value: type,
            text: t(memoryTypeLabelKey(type)),
            selected: (memory?.type ?? "user") === type
          })
        )
      ]);
      return el("div", {}, [
        el("div", { class: "dspp-field" }, [
          el("label", { text: t("name") }),
          nameInput
        ]),
        el("div", { class: "dspp-field" }, [
          el("label", { text: t("content") }),
          contentInput
        ]),
        el("div", { class: "dspp-row" }, [
          el("div", { class: "dspp-field" }, [el("label", { text: t("type") }), typeSelect]),
          el("div", { class: "dspp-field" }, [el("label", { text: t("tags") }), tagsInput])
        ]),
        el("div", { class: "dspp-form-actions" }, [
          el("button", {
            class: "dspp-btn",
            text: t("cancel"),
            on: {
              click: () => {
                editingMemory = null;
                creatingMemory = false;
                void render();
              }
            }
          }),
          el("button", {
            class: "dspp-btn is-primary",
            text: t("save"),
            on: {
              click: async () => {
                const name = nameInput.value.trim();
                const content = contentInput.value.trim();
                if (!name || !content) return;
                const tags = tagsInput.value.split(",").map((tag) => tag.trim()).filter(Boolean);
                const type = typeSelect.value;
                if (memory?.id !== void 0) {
                  await updateMemory({ ...memory, name, content, tags, type, description: name });
                } else {
                  await saveMemory({
                    type,
                    name,
                    content,
                    description: name,
                    tags,
                    pinned: false
                  });
                }
                editingMemory = null;
                creatingMemory = false;
                showToast(t("savedToast"));
                await options.onStateChanged();
                await render();
              }
            }
          })
        ])
      ]);
    }
    async function renderPresets() {
      if (creatingPreset || editingPreset) {
        bodyEl.appendChild(renderPresetForm(editingPreset));
        return;
      }
      const [presets, activeId] = [await getAllPresets(), getActivePresetId()];
      bodyEl.appendChild(
        el("div", { class: "dspp-toolbar" }, [
          el("button", {
            class: "dspp-btn is-primary",
            text: t("newPreset"),
            on: {
              click: () => {
                creatingPreset = true;
                void render();
              }
            }
          }),
          activeId && el("button", {
            class: "dspp-btn",
            text: `${t("activePreset")}: ${t("none")}`,
            on: {
              click: async () => {
                await setActivePresetId(null);
                await options.onStateChanged();
                await render();
              }
            }
          })
        ])
      );
      if (presets.length === 0) {
        bodyEl.appendChild(el("div", { class: "dspp-empty", text: t("empty") }));
        return;
      }
      const list = el("div", { class: "dspp-list" });
      for (const preset of presets) {
        const isActive = preset.id === activeId;
        list.appendChild(
          el("div", { class: "dspp-card" }, [
            el("div", { class: "dspp-card-head" }, [
              el("span", { class: "dspp-card-name", text: preset.name }),
              isActive && el("span", { class: "dspp-badge is-user", text: t("activePreset") })
            ]),
            el("div", {
              class: "dspp-card-content",
              text: preset.content.length > 300 ? `${preset.content.slice(0, 300)}…` : preset.content
            }),
            el("div", { class: "dspp-card-meta" }, [
              el("span", { style: "flex:1" }),
              el("div", { class: "dspp-card-actions" }, [
                el("button", {
                  class: "dspp-btn is-small",
                  text: isActive ? t("none") : t("activePreset"),
                  on: {
                    click: async () => {
                      await setActivePresetId(isActive ? null : preset.id);
                      await options.onStateChanged();
                      await render();
                    }
                  }
                }),
                el("button", {
                  class: "dspp-btn is-small",
                  text: t("editMemory"),
                  on: {
                    click: () => {
                      editingPreset = preset;
                      void render();
                    }
                  }
                }),
                el("button", {
                  class: "dspp-btn is-small is-danger",
                  text: t("deleteMemory"),
                  on: {
                    click: async () => {
                      if (!confirm(t("confirmDelete"))) return;
                      await deletePreset(preset.id);
                      await options.onStateChanged();
                      await render();
                    }
                  }
                })
              ])
            ])
          ])
        );
      }
      bodyEl.appendChild(list);
    }
    function renderPresetForm(preset) {
      const nameInput = el("input", {
        type: "text",
        value: preset?.name ?? ""
      });
      const contentInput = el("textarea", {
        value: preset?.content ?? "",
        style: "min-height:220px"
      });
      return el("div", {}, [
        el("div", { class: "dspp-field" }, [el("label", { text: t("presetName") }), nameInput]),
        el("div", { class: "dspp-field" }, [
          el("label", { text: t("presetContent") }),
          contentInput
        ]),
        el("div", { class: "dspp-form-actions" }, [
          el("button", {
            class: "dspp-btn",
            text: t("cancel"),
            on: {
              click: () => {
                editingPreset = null;
                creatingPreset = false;
                void render();
              }
            }
          }),
          el("button", {
            class: "dspp-btn is-primary",
            text: t("save"),
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
                  updatedAt: now
                });
                editingPreset = null;
                creatingPreset = false;
                showToast(t("savedToast"));
                await options.onStateChanged();
                await render();
              }
            }
          })
        ])
      ]);
    }
    async function renderSkills() {
      if (creatingSkill || editingSkill) {
        bodyEl.appendChild(renderSkillForm(editingSkill));
        return;
      }
      const skills = await getAllSkills();
      bodyEl.appendChild(
        el("div", { class: "dspp-toolbar" }, [
          el("button", {
            class: "dspp-btn is-primary",
            text: "New skill",
            on: {
              click: () => {
                creatingSkill = true;
                void render();
              }
            }
          })
        ])
      );
      bodyEl.appendChild(
        el("div", { class: "dspp-hint" }, [
          document.createTextNode("Type "),
          el("code", { text: "/skill-name your text" }),
          document.createTextNode(
            " in DeepSeek to expand a skill into its instructions for that turn."
          )
        ])
      );
      if (skills.length === 0) {
        bodyEl.appendChild(el("div", { class: "dspp-empty", text: t("empty") }));
        return;
      }
      const list = el("div", { class: "dspp-list" });
      for (const skill of skills) {
        list.appendChild(
          el("div", { class: "dspp-card" }, [
            el("div", { class: "dspp-card-head" }, [
              el("span", { class: "dspp-card-name", text: `/${skill.name}` }),
              !skill.enabled && el("span", { class: "dspp-badge", text: "off" }),
              !skill.memoryEnabled && el("span", { class: "dspp-badge", text: "identity-only" })
            ]),
            el("div", { class: "dspp-card-content", text: skill.description || skill.instructions.slice(0, 200) }),
            el("div", { class: "dspp-card-meta" }, [
              el("span", { style: "flex:1" }),
              el("div", { class: "dspp-card-actions" }, [
                el("button", {
                  class: "dspp-btn is-small",
                  text: skill.enabled ? "Disable" : "Enable",
                  on: {
                    click: async () => {
                      await saveSkill({ ...skill, enabled: !skill.enabled });
                      await options.onStateChanged();
                      await render();
                    }
                  }
                }),
                el("button", {
                  class: "dspp-btn is-small",
                  text: t("editMemory"),
                  on: {
                    click: () => {
                      editingSkill = skill;
                      void render();
                    }
                  }
                }),
                el("button", {
                  class: "dspp-btn is-small is-danger",
                  text: t("deleteMemory"),
                  on: {
                    click: async () => {
                      if (!confirm(t("confirmDelete"))) return;
                      await deleteSkill(skill.name);
                      await options.onStateChanged();
                      await render();
                    }
                  }
                })
              ])
            ])
          ])
        );
      }
      bodyEl.appendChild(list);
    }
    function renderSkillForm(skill) {
      const nameInput = el("input", {
        type: "text",
        value: skill?.name ?? "",
        attrs: { placeholder: "translate" }
      });
      const descriptionInput = el("input", {
        type: "text",
        value: skill?.description ?? ""
      });
      const instructionsInput = el("textarea", {
        value: skill?.instructions ?? "",
        style: "min-height:200px"
      });
      const memoryCheckbox = el("input", {
        type: "checkbox",
        checked: skill?.memoryEnabled !== false
      });
      return el("div", {}, [
        el("div", { class: "dspp-row" }, [
          el("div", { class: "dspp-field" }, [
            el("label", { text: "Trigger (/name)" }),
            nameInput
          ]),
          el("div", { class: "dspp-field" }, [
            el("label", { text: "Description" }),
            descriptionInput
          ])
        ]),
        el("div", { class: "dspp-field" }, [
          el("label", { text: "Instructions" }),
          instructionsInput
        ]),
        el("label", { class: "dspp-switch" }, [
          memoryCheckbox,
          el("span", { class: "dspp-switch-label", text: "Inject full memory set (off = identity only)" })
        ]),
        el("div", { class: "dspp-form-actions" }, [
          el("button", {
            class: "dspp-btn",
            text: t("cancel"),
            on: {
              click: () => {
                editingSkill = null;
                creatingSkill = false;
                void render();
              }
            }
          }),
          el("button", {
            class: "dspp-btn is-primary",
            text: t("save"),
            on: {
              click: async () => {
                const name = nameInput.value.trim().replace(/^\//, "");
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
                    updatedAt: now
                  },
                  skill?.name
                );
                editingSkill = null;
                creatingSkill = false;
                showToast(t("savedToast"));
                await options.onStateChanged();
                await render();
              }
            }
          })
        ])
      ]);
    }
    async function renderSettings() {
      const settings = await getPromptInjectionSettings();
      const update = async (patch) => {
        await savePromptInjectionSettings(patch);
        await options.onStateChanged();
        showToast(t("savedToast"));
      };
      bodyEl.appendChild(
        switchRow(
          t("memoryEnabled"),
          settings.memoryEnabled,
          (checked) => update({ memoryEnabled: checked })
        )
      );
      bodyEl.appendChild(
        switchRow(
          t("systemPromptEnabled"),
          settings.systemPromptEnabled,
          (checked) => update({ systemPromptEnabled: checked })
        )
      );
      bodyEl.appendChild(
        switchRow(
          "Activity toasts",
          settings.showActivityToasts,
          (checked) => update({ showActivityToasts: checked })
        )
      );
      bodyEl.appendChild(
        selectRow(
          t("presetCadence"),
          [
            ["default", t("cadenceDefault")],
            ["first_message", t("cadenceFirst")],
            ["every_message", t("cadenceEvery")],
            ["off", t("cadenceOff")]
          ],
          settings.presetCadence,
          (value) => update({ presetCadence: value })
        )
      );
      bodyEl.appendChild(
        selectRow(
          t("forceLanguage"),
          [
            ["auto", t("languageAuto")],
            ["zh-CN", t("languageZh")],
            ["en", t("languageEn")]
          ],
          settings.forceResponseLanguage,
          (value) => update({
            forceResponseLanguage: value
          })
        )
      );
      bodyEl.appendChild(
        selectRow(
          "Interface language",
          [
            ["auto", t("languageAuto")],
            ["zh-CN", t("languageZh")],
            ["en", t("languageEn")]
          ],
          settings.uiLocale,
          (value) => update({ uiLocale: value })
        )
      );
      bodyEl.appendChild(
        el("div", { class: "dspp-toolbar", style: "margin-top:16px" }, [
          el("button", {
            class: "dspp-btn",
            text: t("exportData"),
            on: { click: () => void exportAll() }
          }),
          el("button", {
            class: "dspp-btn",
            text: t("importData"),
            on: { click: () => void importAll() }
          })
        ])
      );
    }
    function switchRow(label, checked, onChange) {
      const input = el("input", { type: "checkbox", checked });
      input.addEventListener("change", () => void onChange(input.checked));
      return el("label", { class: "dspp-switch" }, [
        input,
        el("span", { class: "dspp-switch-label", text: label })
      ]);
    }
    function selectRow(label, entries, value, onChange) {
      const select = el(
        "select",
        {},
        entries.map(
          ([entryValue, entryLabel]) => el("option", { value: entryValue, text: entryLabel, selected: entryValue === value })
        )
      );
      select.addEventListener("change", () => void onChange(select.value));
      return el("div", { class: "dspp-field", style: "margin-top:10px" }, [
        el("label", { text: label }),
        select
      ]);
    }
    async function exportAll() {
      const [memories, presets, skills, settings] = await Promise.all([
        getAllMemories(),
        getAllPresets(),
        getAllSkills(),
        getPromptInjectionSettings()
      ]);
      downloadJson(`deepseek-pp-userscript-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`, {
        schemaVersion: 1,
        exportedAt: Date.now(),
        memories,
        presets,
        activePresetId: getActivePresetId(),
        skills,
        settings
      });
    }
    async function importAll() {
      const data = await pickJsonFile();
      if (!data || typeof data !== "object") return;
      const payload = data;
      let importedCount = 0;
      if (Array.isArray(payload.memories)) {
        const ids = await importMemoriesAtomically(payload.memories);
        importedCount = ids.length;
      }
      if (Array.isArray(payload.presets)) {
        for (const preset of payload.presets) {
          await savePreset(preset);
        }
      }
      if (Array.isArray(payload.skills)) {
        for (const skill of payload.skills) {
          await saveSkill(skill);
        }
      }
      if (payload.settings && typeof payload.settings === "object") {
        await savePromptInjectionSettings(payload.settings);
      }
      showToast(t("importedToast", { count: importedCount }));
      await options.onStateChanged();
      await render();
    }
    const controller = {
      open() {
        overlay.hidden = false;
        syncTheme(host2);
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
        document.removeEventListener("keydown", onKeyDown);
        host2.remove();
      }
    };
    return controller;
  }
  function memoryTypeLabelKey(type) {
    switch (type) {
      case "user":
        return "typeUser";
      case "feedback":
        return "typeFeedback";
      case "topic":
        return "typeTopic";
      case "reference":
      default:
        return "typeReference";
    }
  }
  function syncTheme(host2) {
    const documentTheme = document.documentElement.getAttribute("data-theme") ?? document.body?.getAttribute("data-theme");
    const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = documentTheme ? documentTheme.includes("dark") : prefersDark;
    host2.setAttribute("data-theme", isDark ? "dark" : "light");
  }

  // userscript/src/main.ts
  var TOOL_DESCRIPTORS = createMemoryToolDescriptors();
  var state = {
    locale: detectLocale(),
    settings: {
      memoryEnabled: true,
      systemPromptEnabled: true,
      presetCadence: "default",
      forceResponseLanguage: "auto",
      showActivityToasts: true,
      uiLocale: "auto"
    },
    messageCounts: /* @__PURE__ */ new Map()
  };
  var panel = null;
  async function refreshSettings() {
    state.settings = await getPromptInjectionSettings();
    state.locale = state.settings.uiLocale === "auto" ? detectLocale() : state.settings.uiLocale;
  }
  async function handleRequestBody(body) {
    const decoded = decodeDeepSeekRequestBody(body);
    if (!decoded) return null;
    await refreshSettings();
    const [memories, activePreset, activeProject, skills] = await Promise.all([
      getAllMemories(),
      getActivePreset(),
      getActiveProject(),
      getEnabledSkills()
    ]);
    const sessionId = typeof decoded.chat_session_id === "string" ? decoded.chat_session_id : "unknown";
    const messageCount = state.messageCounts.get(sessionId) ?? 0;
    const result = augmentDecodedRequestBody(decoded, {
      memories,
      skills: skills.map((skill) => ({
        name: skill.name,
        instructions: skill.instructions,
        memoryEnabled: skill.memoryEnabled
      })),
      activePreset,
      projectContext: activeProject?.instructions ?? null,
      projectId: activeProject?.id ?? null,
      toolDescriptors: TOOL_DESCRIPTORS,
      messageCount,
      locale: state.locale,
      promptSettings: state.settings
    });
    state.messageCounts.set(sessionId, result.messageCount);
    if (result.usedMemoryIds.length > 0) {
      void touchMemories(result.usedMemoryIds).catch(
        (error) => console.error(`[${SCRIPT_NAME}] touchMemories failed`, error)
      );
      if (state.settings.showActivityToasts) {
        showToast(
          translateUi(state.locale, "memoryInjected", { count: result.usedMemoryIds.length })
        );
      }
    }
    return { body: result.body, originalPrompt: result.originalPrompt };
  }
  async function handleToolCall(call) {
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
  function bootstrapPanel() {
    if (panel) return;
    panel = mountPanel({
      locale: state.locale,
      onStateChanged: async () => {
        await refreshSettings();
      }
    });
    const registerMenuCommand = globalThis.GM_registerMenuCommand;
    registerMenuCommand?.(translateUi(state.locale, "openPanel"), () => panel?.open());
  }
  function whenDomReady(callback) {
    if (document.body) {
      callback();
      return;
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    const timer = setInterval(() => {
      if (!document.body) return;
      clearInterval(timer);
      callback();
    }, 50);
  }
  function main() {
    try {
      installNetworkHooks();
      updateHookState({
        toolDescriptors: TOOL_DESCRIPTORS,
        onRequestBody: (body) => handleRequestBody(body),
        onToolCall: (call) => void handleToolCall(call),
        onResponseComplete: () => void 0
      });
    } catch (error) {
      console.error(`[${SCRIPT_NAME}] network hooks failed to install`, error);
    }
    void refreshSettings().catch(
      (error) => console.error(`[${SCRIPT_NAME}] settings load failed`, error)
    );
    whenDomReady(() => {
      void refreshSettings().catch(() => void 0).then(() => {
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
})();
