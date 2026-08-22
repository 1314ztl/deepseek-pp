# DeepSeek++ 油猴脚本版（记忆与个性化）

把 DeepSeek++ 浏览器扩展中**记忆 + 个性化**这条主线，移植成一个可以直接安装的
Tampermonkey / Violentmonkey 用户脚本。

## 已保留的功能

| 能力 | 说明 |
|------|------|
| **跨对话长期记忆** | 记忆存在浏览器 IndexedDB，每次提问自动按相关度筛选注入 |
| **记忆自动保存** | 模型输出 `<memory_save>` XML，脚本解析并写库；`memory_update` / `memory_delete` 同样支持 |
| **记忆打分与预算** | 完整移植扩展的评分算法：置顶 +1000、标签命中 ×20、标题 ×15、正文 ×5，叠加访问次数与新鲜度衰减，按 token 预算截断（长 prompt 自动压缩，下限 800） |
| **系统提示词预设** | 多套 preset，可切换启用，支持注入频率（默认 / 仅首条 / 每条 / 关闭） |
| **项目上下文** | 项目指令随对话注入；记忆支持 project 作用域隔离 |
| **`/skill` 提示词片段** | 自定义 `/名称 参数` 片段展开为完整指令，可单独设置是否注入全量记忆 |
| **强制回复语言** | 自动 / 简体中文 / English |
| **界面清理** | 注入的系统提示词不会显示成用户气泡；工具 XML 不会出现在回复里；刷新后历史同样干净 |
| **数据导入导出** | JSON 格式，与扩展的记忆字段保持一致，可双向迁移 |

## 未包含的功能

以下能力依赖扩展专属权限（后台 Service Worker、Native Messaging、跨域主机权限、
侧边栏 API），用户脚本环境下无法实现，因此不在移植范围内：

MCP 工具、Shell / Native Host、浏览器控制、Python 沙箱、联网搜索与网页读取、
多模态媒体分析、自动化定时任务、云同步（Google Drive / OneDrive / WebDAV）、
对话导出（HTML/PDF）、侧边栏对话、悬浮聊天窗、桌宠。

## 安装

**打包好的单文件已经提交在仓库里，不需要自己构建：**

> [`userscript/dist/deepseek-pp.user.js`](dist/deepseek-pp.user.js)

任选一种方式：

- **方式 A（复制粘贴，最简单）**：在 GitHub 上打开
  [`userscript/dist/deepseek-pp.user.js`](dist/deepseek-pp.user.js) →
  点右上角 **Raw** → 全选复制 → 打开 Tampermonkey 管理面板 → 「+」新建脚本 →
  清空默认内容 → 粘贴 → `Ctrl/Cmd + S` 保存。
- **方式 B（一键安装）**：直接在浏览器打开该文件的 raw 链接（以 `.user.js` 结尾），
  Tampermonkey 会自动弹出安装页。
- **方式 C（拖拽）**：把本地的 `userscript/dist/deepseek-pp.user.js` 拖进浏览器窗口。

安装完成后打开 <https://chat.deepseek.com>，右下角会出现 `M+` 悬浮按钮。

> 修改源码后需要重新生成单文件：`npm run userscript:build`
> （输出仍然是 `userscript/dist/deepseek-pp.user.js`，记得一并提交）。

## 使用

- 点击右下角 **M+** 按钮（或 Tampermonkey 菜单里的「打开 DeepSeek++ 面板」）打开管理面板。
- **记忆**页：搜索、新增、编辑、置顶、删除，导入导出，清理陈旧记忆。
- **系统提示词**页：新建 preset 并设为启用。
- **Skills** 页：定义 `/名称` 片段，在输入框输入 `/名称 你的内容` 即可展开。
- **设置**页：记忆注入开关、系统提示词开关、preset 注入频率、强制回复语言、界面语言。

正常聊天即可 —— 当你说到身份、偏好、技术栈，或明确说「记住」时，模型会自动调用
`memory_save`，右下角会弹出提示。下次对话时相关记忆会自动带入。

## 架构

```
src/
  main.ts                     入口：装 hook → 载状态 → 增强请求 → 执行工具 → 挂面板
  constants.ts                记忆预算、preset 周期、停用词（与扩展一致）
  i18n.ts                     系统提示词模板（逐字移植）+ 界面文案
  storage.ts                  GM_* / localStorage 抽象，串行队列 + 校验仓储
  types.ts                    与扩展兼容的数据契约
  memory/
    codec.ts                  严格校验（坏数据显式失败，不静默覆盖）
    store.ts                  IndexedDB 存储，syncId 去重，事务内先读后写
    selector.ts               分词、打分、衰减、token 预算
    scope.ts                  project 作用域过滤
  prompt/
    augmentation.ts           拼装最终 prompt
    visibility.ts             可见用户输入标记
    settings.ts               注入开关与 preset 周期策略
    request-augmentation.ts   请求级编排（记忆 + preset + 项目 + skill）
  tool/
    xml-tags.ts               线性时间标签扫描（防 ReDoS）
    parser.ts                 工具调用提取 / 剥离
    streaming-text.ts         流式可见文本累加（跨 chunk 标签保护）
    memory-tools.ts           三个记忆工具的 schema 与执行
  deepseek/
    routes.ts                 路由匹配
    sse.ts                    SSE 帧解析与 patch 读写
  interceptor/
    network-hook.ts           fetch / XHR / IndexedDB 三处 hook
    stream-filter.ts          流式剥离工具 XML + 还原用户输入
    history-cleanup.ts        历史消息清理
  ui/                         Shadow DOM 管理面板
```

### 关键设计决定

- **`document-start` + 页面上下文**：扩展用 MAIN world content script 抢在
  DeepSeek 打包代码之前替换 `fetch`；用户脚本用 `@run-at document-start` 达到同样效果，
  因此不需要 content script 与后台之间的桥接。
- **失败即放行**：增强逻辑一旦抛错，就原样发送用户的原始请求。记忆功能永远不能
  把用户的聊天搞挂。
- **改写而非丢弃 SSE 帧**：DeepSeek 前端把 fragment 创建事件当作结构事件，丢帧会让
  它的渲染器错位，所以过滤器是「克隆 patch 并改写其中文本」。
- **不打包 React**：面板用原生 DOM + Shadow DOM，脚本体积约 150 kB 且可读，
  便于 Greasy Fork 审核。

## 开发

```bash
npm run userscript:compile   # 类型检查
npm run userscript:test      # 58 个单元测试
npm run userscript:build     # 打包单文件到 userscript/dist/deepseek-pp.user.js
npm run userscript:check     # 三者串跑
```

## 与扩展的数据互通

记忆的字段结构（`syncId` / `scope` / `type` / `tags` / `accessCount` 等）与扩展一致，
`syncId` 作为去重键，因此从扩展导出的记忆 JSON 可以直接导入本脚本，重复导入只会更新
不会产生副本。preset 与注入设置使用相同的存储键名。
