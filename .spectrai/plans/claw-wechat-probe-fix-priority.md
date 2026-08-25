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
| **P3.8** | **整窗灰：restore 后重绘 + 近单色→PrintWindow，仍灰报 capture_blank** | ✅ `033afdf` |
| **P3.9** | **非点击/托盘隐藏恢复：`!visible` 也 Show+Repaint；follow 近灰→PrintWindow** | ✅ `a8fc624` |
| **P3.10** | **annotated 缓存：path normalize + miss 时 hydrate `.meta.json`** | ✅ `9090983` |
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

## 冒烟复测（2026-08-25，Local Latest / P3.6–P3.8 后）

### 浏览器 ✅
1. `browser_get_capabilities`：9222 available（2 targets）
2. 空 selector → `element=null`（无 DEFAULT 假命中）
3. `{type:'css', value:"a[href='/blog_list']"}` click → `urlChanged` + `urlIncludes` 通过
4. 列表页 `{type:'css', value:"a[href*='qwen']"}` find → 命中正确链接
5. 列表页 `{type:'css', value:"a[href*='deepseek-harness…']"}` click → `urlChanged` 通过  
   （中间一次 text 点击因视口/未导航落成 mutation 失败，属页面滚动态，不是 selector 归一化回退）

### 微信 ⚠️ 半通（卡在手机确认登录）
1. `window_focus(title=微信)` ✅ `visible=true;iconic=false`
2. `screenshot(followForeground/followWindowTitle)` ✅ **不再整窗灰**  
   - `wechat-smoke2-follow/main/region/after-enter` uniq≈1800–2200（对比旧 `m0/main4` uniq=1）
3. UIA 找到「进入微信」Button；`mouse_click` 后进入「需在手机上完成登录」
4. `click_element(number, screenshotPath=…)` ❌ 仍报 `No annotated elements`（**annotated 缓存仍是阻塞**）
5. **未继续开群/发消息**（需手机确认登录；避免乱点）

## 冒烟复测（2026-08-25 登录后，网页+微信）

### 浏览器 ✅（再核一轮）
1. `browser_get_capabilities`：9222 available（2 targets）
2. 空 selector → `element=null`
3. `a[href='/blog_list']` click → `urlChanged` + `urlIncludes` 通过
4. `a[href*='qwen']` find → 命中正确链接；click → `urlChanged` + `urlIncludes=qwen` 通过

### 微信 ⚠️ 半通（登录后仍未稳定开群）
1. `window_focus` + `followWindowTitle` 截屏前期 ✅ 非灰（uniq≈1600–1800），UIA 可见主界面/`ai 饲料群`
2. 搜索框可点；`keyboard_type` 搜到 `懵逼三人组` ListItem ✅
3. `click_element(number=5, clickType=double)` **不传 screenshotPath** ✅ 返回 `verify=verified`（`elementGone=true; outsideName=true`）
4. 但随后顶栏仍是 `ai 饲料群` ❌ → **激活后验仍可能假阳**（搜索面板关闭也会 `elementGone`）
5. `click_element(..., screenshotPath=…)` ❌ 仍 `No annotated elements`
6. 过程中微信主窗曾变不可见（托盘/隐藏），`window_focus(title)` 一度 `window_not_found`；强制 `ShowWindow` 后恢复，但 region 截图像近灰（uniq≈149）/UIA=0
7. 另启 `Weixin.exe` 拉起登录窗（未继续乱点发消息）

### P3.9 — 非点击/托盘隐藏恢复后灰屏 ✅ `a8fc624`
用户观察对齐：点击进前台通常不灰；`Start-Process` / 裸 Show / 托盘隐藏后再 focus 容易灰。

根因：旧策略只在 `IsIconic` 时 Show+Repaint；托盘隐藏常见 `visible=false && iconic=false`。
次因：PrintWindow 只认 near-mono（uniq≤4）；恢复后近灰 uniq≈149 不触发。

已落地（通用）：
1. focus：`iconic || visible===false` → `SW_RESTORE(9)` + `RepaintAfterRestore`
2. follow 截屏：`isSuspiciousBlankCapture`（near-mono **或** uniq≤256∧var≤200）→ 试 PrintWindow；硬失败仍只认 near-mono

### P3.10 — annotated 缓存 miss ✅ `9090983`
探活：不传 `screenshotPath` ✅；传 path ❌ `No annotated elements`。

根因：`screenshotMetaMap` 路径精确匹配；已写 `.meta.json` 却从不回填。

已落地：
1. `normalizeScreenshotMetaKey`（resolve + `/`；Win 再 lower）
2. miss → sibling `.meta.json` hydrate
3. click/keyboard/screenshot_click/zoom/hud 统一 lookup；path 仍 miss 可用 `lastAnnotatedPath` 兜底并标注 `usedLastAnnotated=true`

## 冒烟复测（2026-08-25，P3.9/P3.10 后）

### 浏览器
1. `browser_get_capabilities`：9222 available（2 targets）✅
2. 空 selector：`{css:"   "}` → `null` ✅；但 `{}` / `{css:""}` 仍 DEFAULT 命中首页首链 ⚠️（边界残留）
3. `{type:'css', value:"a[href='/blog_list']"}` click → `urlChanged` + `urlIncludes` ✅
4. `a[href*='qwen']` find 命中正确链接 ✅

### 微信 ⚠️ 半通（P3.10 过，激活假阳仍卡）
1. `window_focus(handle)` ✅；截屏 **不灰**（follow title uniq≈11k；region 正常）
2. `followWindowTitle` / `followHandle` 仍偏整屏/主屏，**区域截**才稳跟微信窗 ⚠️
3. 搜「懵逼三人组」→ ListItem 可见 ✅
4. **`click_element(number, screenshotPath=…)`**（正斜杠/反斜杠）✅ 不再 `No annotated elements` → **P3.10 实机过**
5. 工具报 `verify=verified`（`elementGone`/`outsideName`）但会话 **未** 切到「懵逼三人组」→ **激活后验假阳仍在**
6. 未发消息（群未真正打开）

### P3.11 — 激活后验假阳（搜索面板关 ≠ 会话已切）✅ `dea5978`
探活：双击搜到的 ListItem → 工具 `verify=verified (elementGone=true;outsideName=true)`，但会话未切到目标。

落地：
1. `activationEvidenceMatches`：**lone `elementGone` 不再算激活**
2. `isActivationOutsideNameControl` / `activationOutsideNameHit`：排除 `Edit|Document|ComboBox`
3. UIA 路径与 `probeActivationLocalEvidence` 对齐；`element_gone` 单独不再 `verified`
4. 门禁：`desktop-action-guards` **30/30**

### P3.11 冒烟（2026-08-25）⚠️ 仍半通 → 随后打通开群
1. 搜到 ListItem「懵逼三人组」✅；带 path 双击 ✅ 不再 No annotated
2. 点「搜索网络结果」下的精确名「懵逼三人组」→ 进 **搜一搜**，不是会话（易误判）
3. 侧栏 `Text「懵逼三人组 - 搜一搜」` → Contains outsideName 假阳仍在（P3.12）

### 冒烟突破（同轮）✅ 开群+输入可用
1. 点「最常使用」下的 `懵逼三人组-下一站翻身`（双击+path）→ 出现 `chat_message_page` / 顶栏群名 / 输入框 ✅
2. `keyboard_type` 写入 `spectrai-claw-smoke-ok` 到聊天输入 ✅
3. 说明：**主路径可用**；此前“打不开群”有一半是点到了网络搜一搜结果，不只是后验假阳

### P3.12 — outsideName 再收紧（Text/Contains 假阳）✅ `bd2d7e7`
落地：outsideName **一律 exact**（`===` / `-eq`）；PowerShell 三处对齐；门禁 **30/30**。
Contains 搜索 chrome Text 不再假阳。

### P3.12 后验复测（同轮）⚠️ 环境中断
1. 合入后 Local Latest 已指向 `mcps/spectrai-claw/dist/index.js`，并 `update_mcp` 刷新
2. 试图对照：网络搜一搜同名 / 最常使用开群
3. **阻塞**：搜一搜侧栏（`weixin-search-input` / `懵逼三人组 - 搜一搜`）抢焦点；随后微信主窗多次截到近灰屏（`elementCount=0`），min/restore/Redraw 后仍灰
4. **结论暂挂实机对照**；代码侧门禁已绿，开群主路径在 P3.12 前已实机打通（`chat_message_page` + 输入 `spectrai-claw-smoke-ok`）

### 冒烟复测（2026-08-25，P3.12 后继续到可用）✅
环境：旧微信主窗持续灰屏 → **杀进程后重新启动**微信；抖音抢前台时先压后台再 focus。
1. 登录窗不灰；点「进入微信」→ 主会话窗可用（UIA `搜索`/`会话` 可见）
2. 搜「懵逼三人组」→ 双击「最常使用」`懵逼三人组-下一站翻身` → `chat_message_page` ✅，`verify=verified`
3. 输入并发送：`我是AI，我来收你们来了。人类先别慌，这次只是冒烟。` → 消息列表可见该条 ✅
4. **P3.12 假阳对照**：双击「搜索网络结果」同名 `懵逼三人组` → `activation_unconfirmed`（`outsideName=false`，**不再 verified**）✅

### 当前状态
- ✅ 开群主路径可用（点「最常使用」会话，勿点「搜索网络结果」）
- ✅ P3.11/P3.12 激活后验假阳代码已合 main，**实机对照已过**
- ✅ 群消息发送成功（黑色幽默 AI 风格）；`Wanne be`「你好」+ 群内 Token 充满消息均已落地
- 可选残留：follow* 偏屏；空 selector DEFAULT；搜索结果选错启发式；灰窗时优先托盘/任务栏点击，仍灰再启动同 exe 激活，**勿杀进程**

### 决策备忘：为何「有识图/坐标」仍像点不准
探活结论：**多数不是像素偏了，而是点错语义目标 / 验成了假成功 / 路径没走 HID 坐标。**
1. 标注号 ≠ 业务目标：同名「懵逼三人组」可在「最常使用」或「搜索网络结果」；点错进搜一搜
2. `click_element` 左键单击优先 `uiaInvoke/uiaSelect`，不是总按 `screenX/Y` 物理点；双击才常落 `hidMouse`
3. 后验假阳（P3.11/12）：`elementGone` / Contains outsideName → 工具报 verified，会话未切
4. OCR 中心点 ≠ 可点控件中心（已有 OCR→UIA 锚定，但纯 OCR 仍可能偏）
5. 焦点/遮挡：侧栏搜一搜、灰屏、`focus_failed` 会让“坐标对了也点不到目标窗”

→ 下一刀仍优先 **验准 + 选对项**，不是再堆识图分辨率。

### 跨应用冒烟（2026-08-25，SpectrAI + 浏览器）
不再只盯微信，补测宿主软件与 Chrome：
1. **SpectrAI 主窗**：最小化恢复 + `window_focus` ✅；`followHandle` 截屏可跟窗
2. **Electron UIA 几乎空**：仅 `Chrome Legacy Window`，`annotate` 基本不可用 → 必须 OCR/坐标/HID
3. **侧栏坐标点击**：OCR 见「工作/自动化/团队」；点「自动化」「团队」后画面有明显变化（中心区 diff 升高，出现「进入团队」等文案）✅
4. **浏览器 DOM**：`find a[href*='qwen']` ✅；`browser_execute_action` 须用 `action.type=click`（`kind` 会 unsupported）；带 `verify.urlIncludes=qwen` 导航后验 ✅

→ 跨应用结论与微信一致：**有通道就能点，但 Electron 不能指望 UIA 标注号；浏览器用 DOM 语义点击更稳。**

### 微信续测（2026-08-25 午后，不杀进程）✅
约束：灰窗只允许任务栏/托盘点击拉起，**禁止杀进程**。
1. 主窗 `handle=22742088` / `pid=52912` 多次落入灰态（UIA `descCount=0`，截图像素近单色）
2. 任务栏绿标双击、托盘溢出区定位：`NotifyIconOverflowWindow` + `ToolbarWindow32` 读到「微信」按钮；物理坐标需按 **DPI 1.5** 换算再点
3. 仅点托盘/任务栏不足以从灰态恢复 UIA；**再启动一次** `Weixin.exe`（不杀旧进程）后实例重绘成功：`desc≈180`，`chat_input_field` 恢复
4. `Wanne be` 会话此前已发出「你好」✅（列表可见）
5. 搜「懵逼三人组」→ 双击「最常使用」`懵逼三人组-下一站翻身` → 输入框可用；发送：`Token已经充满，灵魂还差半格。AI值班中，人类请自觉排队被收。` → 消息列表 `12:54` 可见 ✅
6. 踩坑：托盘坐标漏乘 DPI 会点到 PixPin；「搜索网络结果」同名项仍勿点

### 下一刀候选（按阻塞度）
1. **可选残留**：follow* 偏屏；空 selector `{}`/`{css:""}` DEFAULT；实机复测 P3.9；搜索结果选错（网络 vs 会话）启发式
2. 灰窗运维：优先任务栏/托盘点击；仍灰时可再启动同路径 exe 激活实例，**不要杀进程**；避免死磕 ShowWindow
3. Electron/SpectrAI：若要稳定点侧栏，优先 OCR/坐标路径，别等 UIA 树
4. 托盘点击：Win32 逻辑坐标 × DPI（本机 1.5）再喂给 HID

## 非目标

- 不靠 Agent 多试几次掩盖「验错/假失败」
- 不把「少截图」当本轮 KPI
