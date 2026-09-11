# 更新日志

## v2.1.0 — 2026-09-11

本次版本针对用户反馈集中修复，共 **12 个功能性 Bug（其中 5 个致命）**。

### 🐞 致命问题修复

| # | 问题（用户反馈原文） | 根因 | 修复 |
|---|---|---|---|
| 1 | 「主波为啥脚本只是找没有进行投递」 | 脚本用 `location.pathname.includes("/jobs")` 判断页面，而 BOSS 搜索结果页真实地址是 `/web/geek/job`（**没有 s**）。`Core.startProcessing()` 里两个分支都不命中 → 主循环空转 | 新增统一 `PAGE` 页面识别，兼容 `/job`、`/jobs`、`/recommend`、`/job_detail/` |
| 2 | 「网页刷新设置里面配置信息全消失了」 | 全局 `settings` 初始化时没有读取 `aiApiUrl/aiApiKey/aiModel/userResume/greetingTemplate`，`loadSettingsIntoUI()` 也不回填这些输入框。用户打开设置 → 看到空框 → 点保存 → **空值覆盖本地配置** | 重构为单一配置对象 + 统一读写层 `SettingsStore`，读全写全，并兼容旧键 |
| 3 | 「弹不出来 / 脚本未执行 / 打开不了」 | ① 存在两个同名的 `loadSettingsIntoUI`，后一个覆盖前一个；② `Core.loadAndDisplayComments()` 被调用但从未定义，每次进职位页抛 `TypeError`；③ `UI.notify()` 未定义；④ 残留调试代码 `alert("onclick!")`、`alert("close clicked")`、`alert("ERR: ...")` | 删除重复定义与死调用，补齐缺失方法，移除全部调试 alert |
| 4 | 只找不投递（更深层原因） | 把 `li.job-card-box` 的 DOM 节点缓存进 `state.jobList`。BOSS 点击后会重新渲染列表，缓存节点变成游离节点，后续 `click()` 全部无效；且 `document.querySelector("a.op-btn-chat")` 永远取到的是**卡片上**的按钮 | 改为只缓存 jobId、每轮实时重查 DOM；`findChatButton()` 优先从详情区取按钮；改为点击卡片自带的「立即沟通」（更接近真人操作） |
| 5 | 「AI 招呼语开关看起来没生效」 | `settings.aiGreetingEnabled` 在全局配置里**根本没有定义**（恒为 `undefined`），且 `refreshPanelModeUI()` 在元素还没挂到 DOM 时就调用 `getElementById`，取不到节点 | 配置层补全该字段；开关视觉状态用局部变量同步，并在面板挂载后统一刷新 |

### 🔧 其他修复

6. **投递不再"静默失败"** — 新增投递结果校验：等待按钮文案变化 / 打招呼弹窗 / 聊天输入框 / toast 提示；失败会明确写入日志与「失败」计数。
7. **自动滚动死循环** — 旧版 `scrollStep` 无步数上限，页面持续加载新岗位时会无限递归；现限制 30 步。
8. **AI 系统提示词被覆盖** — `requestAi()` 写成 `localStorage.getItem("aiRole") || systemRole || ...`，导致生成招呼语时用的是"聊天回复"的角色设定；现按 传入 systemRole > AI 角色定位 的优先级取值，并修正 `state.currentGeneratedGreeting` 未初始化的问题。
9. **AI 请求无超时/无重试/报错不可读** — 增加 20s 超时、失败重试、401/402/429 等可读错误；设置面板新增「测试连接」按钮。
10. **Word 简历导入其实一直是坏的** — 旧版直接对 `.docx` 做 UTF-8 文本搜索，但 `.docx` 是 ZIP 压缩包，永远找不到内容。现用浏览器原生 `DecompressionStream` 解压 ZIP 并解析 `word/document.xml`；PDF 也从"不支持"改为尽力提取。
11. **存储与筛选条件不持久** — `StatePersistence.loadState()` 从未被调用，`confirmStorageLimits` 也不生效；现已在启动时调用，筛选关键词、面板位置、投递节奏都会记住。
12. **残留的收费版提示** — 图片简历上传限制提示为「免费版最多添加5个图片简历」；开源项目不应出现，改为中性文案并将上限提到 10 个。

### ✨ 体验优化

- 欢迎信只在首次安装 / 版本升级后出现一次（旧版每天弹一次），并新增 ✕ 关闭按钮。
- 支持 BOSS 单页路由切换（`pushState` / `popstate`）后自动重建面板。
- 新增面板守护：面板被页面重新渲染顶掉时自动补挂。
- 面板底部新增运行统计：已沟通 / 已发简历 / 已跳过 / 失败。
- 新增安全上限设置：投递间隔（默认 2500ms）、单次投递上限（默认 50）。
- 投递失败或页面结构变化时，日志会直接给出原因和下一步操作建议。
- `@match` 从 `https://www.zhipin.com/web/*` 放宽到 `https://www.zhipin.com/*`，避免首页/详情页不生效。

### ⚠️ 行为变化（请注意）

- **AI 半自动模式**：点「一键投递」时，如果预览框里已有招呼语，只投递**当前预览的那一个职位**；预览框为空时才走批量流程。
- **全自动模式**：点「启动海投」批量沟通，只发送「自我介绍」列表里配置的内容（BOSS 自身的招呼语由平台设置决定）。
- 新增的 `useApiApply`（走站内接口）默认关闭。站内私有接口变动频繁且风控风险更高，模拟点击更稳。

---

## v1.8 — 2026-06-08

- AI 智能招呼语、招呼语预览与重新生成
- API 配置（兼容 OpenAI 协议）
- 简历导入（Word / PDF / TXT）
- 一键投递（半自动）与批量海投（全自动）

## v1.0 – v1.7

- 逐步迭代：基础海投 → 接口投递 → 简历发送 → 招呼语模板 → DeepSeek 接入
