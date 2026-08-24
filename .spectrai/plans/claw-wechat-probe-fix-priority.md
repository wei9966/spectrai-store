# SpectrAI Claw 探活修复优先级（准确率优先）

> 通用桌面/浏览器插件；不为单 App 特化。
> 已完成：通道自愈 + 假成功治理 + 通用快点击 + OCR 锚点/可点点 + **P3 后验验准**。
> **当前焦点：准确率（点对 + 验对）**；速度不是本轮主目标，多截图可接受。

## 进度总览

| 阶段 | 解决什么 | 状态 |
|---|---|---|
| P0 | 通道断 / 选中≠激活假成功 / 焦点遮挡 | ✅ `6000693` `80e0595` |
| P1 | 去微信特化 + 通用快路径 | ✅ `78ea80b` |
| P2 | 找对/点对（OCR→UIA、可点点、少空跑 OCR） | ✅ `ca5b6f4` |
| **P3** | **动作后验准：浏览器导航点击假失败 + 桌面激活证据** | ✅ `ee82e5d` `6b9b33c` |
| **P3.5** | **浏览器 selector `{type,value}` 归一化，避免 DEFAULT 首链假命中** | ✅ |
| **P3.6** | **桌面激活后验：title 不变时认通用局部证据（elementGone / 非 selection 名命中）** | ✅ `be41540` |
| **P3.7** | **灰/黑屏：跟窗截屏参数 + 少动已可见窗口（去掉二次 ShowWindow(5)）** | ✅ `6aa43bd` |
| P4 | Swift daemon / 纯视觉主导 | 暂缓 |
| Sync | store → claudeops builtin-mcps（`npm run sync:builtin-claw`） | ✅ 产物已就位（gitignore，打包前再跑） |
| Pack | claudeops 打安装包 | ⬅️ 待你确认再打 |

## 探活真实故障（只记出现过的）

1. PowerShell/UIA 通道超时 / `process not available`
2. `SelectionItem.Select` 返回成功，界面未真正打开目标项
3. 浏览器 Bing 结果页：DOM `click` 链接后验失败，最后靠 `navigate` 兜底才进 DataLearner
4. 桌面侧 `Select`/`vision_click` 不稳，靠双击 HID / Enter 才完成发送

## P3 — 已落地

### 根因：浏览器 DOM 点链接为什么失败

实测路径：Bing 搜索 → 点 DataLearner 指南链接 → 页其实能跳，但工具报失败。

旧口径（`providers/browser/provider.ts`）：
- `click` 默认后验是 `{ mutation: true }`
- 后验优先用**旧 selector** 再读 `after` 状态
- 导航后旧 `<a>` 已卸载 → 读不到 / mutationHash 对不上
- 于是 `verification_failed`，即使 `location.href` 已变

这是**验错了**，不是没点到。

### P3-A 浏览器导航类点击验准 ✅ `ee82e5d`

1. `click` 默认后验分层：优先认 **page URL / title 变化**（或显式 `urlIncludes`）→ 成功
2. 导航后旧节点不可读时改读 **page-level state**，不再因旧 selector 假失败
3. `verification_failed.details` 带 `beforeUrl/afterUrl/beforeTitle/afterTitle/checks`
4. 已有 URL 变化时不再建议 desktop-vision-hid / 强迫 `navigate`
5. 同页控件 click 仍走元素级 `mutation`

单测：链接导航旧节点消失但 URL 变 → `ok=true`；同页 mutation 仍绿。

### P3-B 桌面激活证据验准 ✅ `6b9b33c`

1. 延续 P0/P1：`ListItem|TreeItem|TabItem|MenuItem` 的 Select ≠ 激活
2. **假阳性收紧**：Selected/Focus-only 不算激活；Toggle/Expand/Value/元素消失才算局部证据
3. activatable 无激活证据不得报成功；UIA 后至多一次 HID **double-click** 短路径
4. HID 后仍无证据 → `activation_unconfirmed` 硬失败（不再假成功）
5. 普通 Button/Hyperlink 等非 selection-item 行为保持原样

单测：`desktop-action-guards` 13+ 相关断言全绿。

### P3.5 — 浏览器 selector type/value 归一化 ✅

根因：Agent 常传 `{type:'css', value:"a[href*='x']"}`，内部只认扁平 `css|xpath|...`；未归一时落到 `DEFAULT_SELECTOR`，假命中页面首个 `<a>`。

1. `selector-normalize.ts`：`{type|kind,value}` → 扁平 locator；`aria-label`/`ariaLabel` 别名
2. `tools.ts` schema 接纳 `type`/`value`/`aria-label`，入口统一 normalize
3. `dom-scripts.ts` page 侧内联防御：有具体定位意图但无可用字段 → `candidates=[]`，禁止 DEFAULT 假命中

### 明确不做

- 不为微信/Bing 写特化 AutomationId / URL 表
- 不为「更快」砍截图；准确率优先
- 不把旁路 `.ps1` / 手工 `navigate` 当产品主路径
- 不重接 computer-use 整包架构

## 回归口径

| 指标 | 门槛 |
|---|---|
| 点 `<a href>` 导致同 tab 导航 | 工具返回成功（URL/title 证据），不误报 `verification_failed` |
| 同页按钮 click（无导航） | 仍用元素态/mutation 验证 |
| ListItem Select 未激活 | 不得报成功；一次 HID 降级后仍无证据才失败 |
| 业务代码 App 特化字符串 | 仍为 0 |
| build + 相关单测 | 全绿（本轮复跑 17/17） |

## 冒烟核验（2026-08-24，Local Latest）

### 浏览器 ✅
1. `browser_get_capabilities`：9222 available
2. `{type:'css', value:"a[href*='qwen…']"}` → 命中正确链接，不再落到首页首链
3. 伪/空 selector → `element=null`（不再 DEFAULT 假命中）
4. `{type:'text', value:'DeepSeek Harness…'}` click → `urlChanged` 后验通过
5. 可见导航链 `a[href='/blog_list']` click → `urlChanged` 通过

### 微信（仅懵逼三人组）⚠️ 半通
1. 曾成功：搜索面板打开，UIA 标出 `懵逼三人组` ListItem
2. `click_element` 双击该 ListItem → `activation_unconfirmed`（窗口 title 始终是「微信」，激活证据靠 title 会假失败）
3. 后续窗口被挪/最大化后：UIA 树变空、主屏截图像黑/空，未能完成发「今日热点速览」
4. **未向其他会话发消息**；本轮停在开群前，避免乱点

### 下一刀候选（按阻塞度）
1. **桌面激活证据** ✅ `be41540`：title 不变时认 `elementGone` / 非 selection 名命中
2. **灰/黑屏** ✅ `6aa43bd`：去掉已可见窗的二次 `ShowWindow(5)`；`screenshot` 增加 `followForeground|followHandle|followWindowTitle|followProcessId`（未显式 monitor/区域时跟窗所在屏，找不到回退主屏）
3. **截图/DPI/多屏剩余**：坐标与像素偶发错位仍可能存在；若冒烟仍灰，先让调用方传 `followForeground=true`，再考虑默认跟前台窗
4. **annotated 缓存**：`screenshot annotate=true` 后立刻 `click_element(number, screenshotPath=…)` 偶发 “No annotated elements”（需同一次返回的缓存，或别强绑 savePath）

## 非目标

- 不靠 Agent 多试几次掩盖「验错/假失败」
- 不把「少截图」当本轮 KPI
