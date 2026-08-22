/**
 * Userscript port of core/constants.ts.
 *
 * MEMORY_TOKEN_BUDGET, PRESET_REINJECTION_INTERVAL, STOP_WORDS and
 * SKILL_TRIGGER_REGEX keep their extension values so memory selection and
 * preset cadence behave identically.
 */

export const SCRIPT_NAME = 'DeepSeek++ Userscript';
export const SCRIPT_TAG = 'dspp-us';

export const DEEPSEEK_WEB_ORIGIN = 'https://chat.deepseek.com';

export const DEEPSEEK_WEB_ROUTES = {
  completion: '/api/v0/chat/completion',
  editMessage: '/api/v0/chat/edit_message',
  regenerate: '/api/v0/chat/regenerate',
  history: '/api/v0/chat/history_messages',
} as const;

export const MEMORY_TOKEN_BUDGET = 1500;

export const PRESET_REINJECTION_INTERVAL = 10;

/** Memories older than this without enough use are archived. */
export const STALE_THRESHOLD_DAYS = 90;
export const MIN_ACCESS_FOR_RETENTION = 3;

export const SKILL_TRIGGER_REGEX = /^\/(\S+)\s*([\s\S]*)$/;

export const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '们', '那', '里', '之', '中', '与', '而', '为',
  '以', '及', '等', '被', '把', '让', '给', '从', '向', '对', '但', '如果', '因为',
  '所以', '虽然', '可以', '能', '想', '知道', '时候', '没', '什么', '怎么', '这个',
  '那个', '还', '过', '吗', '呢', '吧', '啊', '嗯', '哦', '呀', '啦', '使用',
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his',
  'by', 'from', 'they', 'we', 'she', 'or', 'an', 'will', 'my', 'one', 'all',
  'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if', 'about', 'who',
  'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'no', 'just',
  'him', 'know', 'take', 'into', 'your', 'some', 'could', 'them', 'than',
  'other', 'been', 'has', 'its', 'use', 'two', 'how', 'our', 'way',
]);
