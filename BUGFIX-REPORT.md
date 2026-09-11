# BOSS 海投助手 v2.1.0 问题诊断与修复报告

> 诊断方式：通读 `boss-quick-apply.user.js`（4888 行）全量代码 + 用 jsdom 在模拟 BOSS 页面上实际运行脚本 + 36 项回归测试。
> 结论：**用户反馈的 5 类问题全部定位到具体代码行，均已修复，回归测试 36/36 通过。**

---

## 一、用户反馈 → 根因对照表

| 反馈原文 | 出现时间 | 根因（代码级） | 状态 |
|---|---|---|---|
| 「主波为啥脚本只是找没有进行投递」 | 8/5 | 页面判断用 `/jobs`，真实地址是 `/job` | ✅ 已修复 |
| 「网页刷新设置里面配置信息全消失了」 | 8/25 | 配置读不全 + 设置弹窗空值覆盖 | ✅ 已修复 |
| 「打开不了是怎么回事」 | 7/7 | 缺失函数抛错 + 调试 alert 打断 | ✅ 已修复 |
| 「没有自动弹出来啊」 | 6/30 | 欢迎信只在 `/jobs` 路径弹出，实际页面不匹配 | ✅ 已修复 |
| 「弹不出来 脚本未执行 edge和chrome都不行」 | 6/22 | 面板注入时机 + 存在未定义函数 | ✅ 已修复 |

---

## 二、致命缺陷详解

### 缺陷 1：页面地址判断错误 —— "只找不投递"的元凶

**旧代码：**

```js
async startProcessing() {
  if (location.pathname.includes("/jobs")) await this.autoScrollJobList();

  while (state.isRunning) {
    if (location.pathname.includes("/jobs")) await this.processJobList();
    else if (location.pathname.includes("/chat")) await this.handleChatPage();
    await this.delay(CONFIG.BASIC_INTERVAL);
  }
}
```

BOSS 网页版职位搜索页的真实地址是：

```
https://www.zhipin.com/web/geek/job?query=前端&city=101210100
                                    ↑ 没有 s
```

`"/web/geek/job".includes("/jobs")` → **false**，所以：

- 不会自动滚动收集岗位；
- `while` 循环里两个分支都不命中，`processJobList()` **永远不会被调用**；
- 用户看到的现象就是"脚本在跑，但什么都没投"。

**影响范围**：只要用户从 BOSS 顶部导航进入职位页（也就是绝大多数用户），脚本 100% 失效。

**修复：** 新增 `PAGE` 模块，统一判断：

```js
isJobList() {
  const p = location.pathname;
  if (PAGE.isChat() || PAGE.isGreetSettings()) return false;
  return /\/web\/geek\/jobs?(\/|$)/.test(p) ||   // 兼容 /job 与 /jobs
         /\/web\/geek\/recommend/.test(p) ||
         /\/web\/geek\/job-list/.test(p) ||
         PAGE.isJobDetail();
}
```

全脚本 6 处硬编码路径判断全部替换。

---

### 缺陷 2：配置读不全 + 空值覆盖 —— "刷新后配置全消失"

**旧代码里有两个互相不同步的配置对象：**

```js
// 第 112 行：state.settings
state.settings = { useAutoSendResume, aiGreetingEnabled, ai: { role }, ... }

// 第 1708 行：全局 settings（另一份）
const settings = {
  useAutoSendResume: ...,
  ai: { role: ... },        // ← 只有 role，没有 apiUrl / apiKey / model
  ...
  // ← 没有 resume、没有 greetingTemplate、没有 aiGreetingEnabled
};
```

而保存逻辑长这样：

```js
// saveSettings()：读的是 settings.ai.apiUrl（undefined）
localStorage.setItem("aiApiUrl", settings.ai.apiUrl || "");   // ← 写成空串！
localStorage.setItem("userResume", settings.resume);          // ← undefined → "undefined"
```

同时 `loadSettingsIntoUI()` **也没有回填这几个输入框**：

```js
function loadSettingsIntoUI() {
  aiRoleInput.value = settings.ai.role;      // 只回填了角色
  // ❌ 没有回填 ai-api-url-input / ai-api-key-input / ai-model-input
  // ❌ 没有回填 user-resume-input / greeting-template-input
  updateStatusOptions();
}
```

**完整失败链路：**

1. 用户第一次配置好 API Key、简历、模板 → 保存在 localStorage；
2. 用户刷新页面 → 全局 `settings` 初始化时**没读**这些键 → 内存中是 `undefined`；
3. 用户打开设置弹窗 → `loadSettingsIntoUI()` 不回填 → **输入框是空的**；
4. 用户点「保存设置」→ `saveSettings()` 把空值/`undefined` 写回 localStorage；
5. **配置永久丢失。**

> 这解释了为什么反馈是"刷新**设置里面**配置信息全消失了"——用户是打开设置面板才发现的。

**修复：**

- 建立唯一配置对象 `settings`，让 `state.settings = settings` 指向同一引用；
- 新增 `SettingsStore.load()/save()`，覆盖全部 26 个配置键，并提供 `readBool/readJSON/readString/readNumber` 安全读取；
- 保留 `settings.ai.role` / `settings.actionDelays.click` 的访问器，兼容旧代码写法；
- `loadSettingsIntoUI()` 补全所有输入框回填 + 开关视觉状态同步；
- 兼容旧键 `excludeKeywords` → `locationKeywords`。

---

### 缺陷 3：脚本运行时抛错 + 调试残留

| 位置 | 问题 |
|---|---|
| `UI.init()` | 调用 `Core.loadAndDisplayComments()`，但该函数**从未定义**（评论区功能被删了，调用点没删）→ `TypeError` |
| `UI.init()` 的 `setTimeout` | 同上，进入职位页 500ms 后必抛错 |
| `handleGreetSettingsPage()` | 调用 `UI.notify()`，该函数**未定义** |
| `_createHeader()` | 残留调试代码：`alert("onclick!")`、`alert("close clicked")`，点设置和关闭按钮都会弹窗 |
| `init()` catch | `alert("ERR: " + error.message)`，一旦初始化异常就用弹窗打断用户 |
| `loadSettingsIntoUI` | 定义了**两次**（2795 行与 4853 行），后者覆盖前者，导致前者的完整逻辑成为死代码 |

jsdom 实测（修复前）：

```
TypeError: Core.loadAndDisplayComments is not a function
    at eval (…:1076:16)
```

**修复：** 删除重复定义与所有死调用；补齐 `UI.notify`；移除全部调试 alert，改为页内 toast 提示；`init()` 增加容错与重试。

---

### 缺陷 4：DOM 节点缓存失效 —— 投递无效

**旧代码：**

```js
state.jobList = Array.from(document.querySelectorAll("li.job-card-box")).filter(...);
...
const currentCard = state.jobList[state.currentIndex];
currentCard.click();      // ← 第一次有效
```

BOSS 是 React 单页应用，点击职位卡片后列表会重新渲染，`state.jobList` 里保存的 DOM 节点全部变成**游离节点（detached）**，之后 `click()` 不再有任何效果。

另外：

```js
const chatBtn = document.querySelector("a.op-btn-chat");
```

`a.op-btn-chat` 在**职位卡片底部**和**详情区**都存在，`querySelector` 取到的是文档中第一个，也就是**卡片上的**按钮。点完之后该按钮变成"继续沟通"，下一个职位再取还是它 → 被判为"已沟通过，跳过"。

> 这个 bug 在回归测试里被自动抓出来了（测试报告 `3 个岗位全部成功沟通` 一开始只通过 1 个）。

**修复：**

- 只缓存 jobId，循环内用 `findCardById(jobId)` 实时重查 DOM；
- `findChatButton()` 优先在详情区（`.job-detail-op` / `.job-detail-box` …）查找，兜底时才在全文档找并**排除卡片内按钮**；
- 主操作改为点击**卡片自带的「立即沟通」**（真人最常用的路径，不依赖详情区刷新）；
- 新增 `waitApplyResult()` 校验投递是否真的生效。

---

### 缺陷 5：AI 招呼语开关实际永远关闭

```js
// 全局 settings 里根本没有 aiGreetingEnabled 这个键
if (card && settings.aiGreetingEnabled && settings.ai.apiKey && settings.resume ...)
//          ↑ 恒为 undefined → 整个分支永不执行
```

即使在 `_createFilterContainer` 里调用 `refreshPanelModeUI()`，也拿不到节点：

```js
aiSw.appendChild(aiTh); aiRow.appendChild(aiSw);
refreshPanelModeUI();          // ← 此时 aiSw 还没 appendChild 到 document
```

`document.getElementById("ai-greeting-toggle")` → `null`，开关背景色/滑块位置**从未被设置过** → 用户看到开关是灰的，以为功能没开。

**修复：** 配置层补上 `aiGreetingEnabled`；开关视觉状态先用局部变量直接设置；面板挂载到 document 后再统一调用一次 `refreshPanelModeUI()`。

---

## 三、其它修复（7 项）

| # | 问题 | 说明 |
|---|---|---|
| 6 | 自动滚动死循环 | `scrollStep()` 无步数上限，页面持续加载时无限递归；现限制 30 步 |
| 7 | AI 系统提示词被覆盖 | `localStorage.getItem("aiRole") \|\| systemRole \|\| ...` → 生成招呼语时用了聊天回复的角色设定 |
| 8 | AI 请求无超时/无重试 | 增加 20s 超时、失败重试、401/402/429 可读报错；设置面板加「测试连接」按钮 |
| 9 | Word 导入一直是坏的 | 旧版对 `.docx` 做 UTF-8 文本搜索，但 docx 是 ZIP 压缩包 → 永远解析不出内容。现用 `DecompressionStream` 解压并解析 `word/document.xml` |
| 10 | PDF 导入 | 从"不支持"改为尽力提取文本流（扫描件仍建议转 docx/txt） |
| 11 | `loadState()` 从未被调用 | 筛选关键词、存储上限清理全部失效；现启动时调用 |
| 12 | 收费版残留提示 | 「免费版最多添加5个图片简历」，开源项目不应出现，已改为中性文案 |
| 13 | 欢迎信每天弹一次 | 改为只在首次安装/版本升级后弹一次，并加 ✕ 关闭按钮 |

---

## 四、验证方式

### 回归测试（36 项，全部通过）

```
=== 场景 1：职位页 /web/geek/job（旧版无法识别的地址）===
✅ 面板已注入
✅ 迷你图标已注入
✅ 日志不再提示"当前页面暂不支持"
✅ 运行时报错为空（旧版这里是 loadAndDisplayComments is not a function）
✅ 没有调试用 alert 弹出
=== 场景 2：点击「启动海投」执行投递 ===
✅ 投递流程真的执行了（日志出现"开始逐个沟通"）
✅ 3 个岗位全部成功沟通  → 已沟通=3 失败=0
=== 场景 3：保存设置后刷新，配置是否还在 ===
✅ 刷新后 API Key 仍在输入框（旧版此处为空 → 保存即丢失）
✅ 刷新后 API 地址仍在
✅ 刷新后简历仍在
✅ 刷新后招呼语模板仍在
✅ 再次保存不会把配置清空（旧版核心 bug）
=== 场景 4：职位页 /web/geek/jobs ===      ✅ 全部通过
=== 场景 5：聊天页 /web/geek/chat ===      ✅ 全部通过
=== 场景 6：AI 半自动模式只投递当前预览职位 === ✅ 全部通过
```

### 简历解析测试（6 项，全部通过）

```
=== 场景 A：解析 .docx（deflate 压缩的真实 zip 结构）===
识别结果：
Zion Cai
杭州 · 前端开发工程师 · 5年经验
技能：Vue / React / TypeScript / Node.js
✅ 识别出姓名 / 中文技能行 / 段落换行正确
=== 场景 B：解析 .pdf（未压缩文本流）===   ✅ 通过
=== 场景 C：非法 docx 应给出明确错误 ===   ✅ 通过
```

测试脚本：`debug/regression.js`、`debug/test-resume.js`

---

## 五、给用户的升级说明

1. 打开 Tampermonkey → 找到「菜大师boss海投助手」→ 用 v2.1.0 全文替换 → Ctrl+S 保存；
2. 刷新 BOSS 职位页（建议 Ctrl + F5）；
3. **旧配置会自动迁移**（`excludeKeywords` → `locationKeywords`），但如果你之前配置被清空过，需要重新填写一次 API Key 和简历；
4. 建议在「设置 → AI 设置」点一次「测试连接」确认 API 可用；
5. 首次使用建议把「投递间隔」保持在 2500ms 以上，避免风控。

> ⚠️ 合规提醒：自动投递属于对 BOSS 直聘的自动化操作，存在平台风控与账号风险。请遵守平台协议，控制投递频率，仅用于个人求职。
