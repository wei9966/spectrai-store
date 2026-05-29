# SpectrAI Claw Windows 准确性改造 —— 细化实施方案（file:line 级）

> 本文件是 `windows-claw-accuracy-mission-plan.md`（理论计划）的落地版。
> 基于对真实代码的研究，给出确切文件、函数、插入点、复用来源与执行顺序。

## 核心结论（决定执行模型）

1. **`src/tools/desktop-tools.ts`（2354 行）是唯一被注册的 Windows MCP 路径。**
   `src/index.ts` 只 wire 了 `registerDesktopTools()` + `registerBrowserComputerUseTools()`，
   `src/computer-use/providers/windows/` 整套 runtime **未暴露成 MCP 工具**。

2. **目标逻辑大部分已存在于未接线的 computer-use provider，本次以「移植 + 接线」为主：**
   - `computer-use/providers/windows/uia-mapper.ts:271-292` `scoreElementSelector()` —— selector 优先级打分（纯 TS，可直接 import）
   - `uia-mapper.ts:112-164` `inferElementCapability()` —— Invoke/Toggle/SelectionItem/ExpandCollapse/Value 模式识别（纯 TS）
   - `uia-mapper.ts:294-320` `elementMatchesSelector` / `findElementsInTree`（纯 TS）
   - `computer-use/providers/windows/provider.ts:520-537 + 858-882` —— 动作后状态回读 PowerShell + 比较逻辑
   - `computer-use/core/verification.ts` + `types.ts:241` `VerificationResultSchema` —— 验证结果 schema（`ok:boolean` + message，无 uncertain/needs_resnapshot/state_not_changed 枚举，需扩展）

3. **三块工作高度重叠 `desktop-tools.ts` 同一批区域 → 不能并行 worktree，采用顺序流水线 A→B→C。**

## 当前数据结构

`desktop-tools.ts:51-65` `interface AnnotatedElement`：
```
number, name, controlType, screenX, screenY,
automationId?, className?, processId?,
rectX?, rectY?, rectW?, rectH?, source?: 'UIA'|'OCR'
```
缺字段：`isEnabled` / `isOffscreen` / `patterns` / `capabilities`（参考 provider 的 `ElementNode`，types.ts:54-87 已有全部字段）。

PowerShell 枚举现状（`annotateScript` 内 Phase 1，desktop-tools.ts:727-749）：
- `FindAll(Descendants, TrueCondition)` 后仅按 bounds / 中心点可见 / 有 label 或 clickable controlType 过滤，cap 80。
- 当前输出列（行 853）：`N|Name|CT|CX|CY|AID|CLS|PID|X|Y|W|H|Src`（**不含 IsEnabled/IsOffscreen/Patterns**）。
- TS 解析在 856-890。

---

## 执行顺序与子任务

### Step A —— UIA 候选过滤打分 + selector 工作流

**改动文件：仅 `src/tools/desktop-tools.ts`（+ import uia-mapper 纯函数）**

A1. 扩展 PowerShell 枚举（desktop-tools.ts:727-749）
   - 在 foreach 内为每个 `$el` 采集：`IsEnabled`（`$el.Current.IsEnabled`）、`IsOffscreen`（`$el.Current.IsOffscreen`）、可用 patterns。
   - patterns 采集：用 `$el.GetSupportedPatterns()` 或逐个 `TryGetCurrentPattern` 探测 Invoke/Toggle/SelectionItem/ExpandCollapse/Value，拼成 `;` 分隔串。
   - 过滤强化：`IsOffscreen=true` 跳过；`IsEnabled=false` 降权（不直接删，标记）；纯 `Image` 且无 pattern 跳过；过大容器（已有 733）保留；父子重复（同 bounds 同 name 取叶子/有 pattern 者）。
   - 输出列追加：`...|Src|EN|OFF|PAT`（行 853 + 行 746 的 hashtable）。

A2. 扩展类型与解析
   - `AnnotatedElement`（51-65）加 `isEnabled?:boolean; isOffscreen?:boolean; patterns?:string[]`。
   - TS 解析（856-890）解析新增列。

A3. TS 端打分排序
   - `import { inferElementCapability } from '../computer-use/providers/windows/uia-mapper.js'`（纯函数，无副作用）。
   - 对解析出的 elements 计算 capability，按「可操作性」排序后再编号/标注（影响 Phase 3 编号与返回列表 892-902）。
   - 降权规则落在 TS：无 pattern + 空 name → 末位或剔除。

A4. selector 主工作流
   - 现有 `uia_find_element`（约 1702-1772）只返回原始匹配。增强为：构造 `ElementSelector`，用 `scoreElementSelector` + `findElementsInTree` 思路排序；
     歧义（多个高分接近）时返回候选集而非猜一个。优先级 AutomationId>Name+ControlType>结构化 query>number 已由打分权重体现。
   - 保留 `click_element(number)` 完全不变（兼容）。

**A 的门禁**：`npm run build && npm run test:computer-use`；新增 uia-mapper 相关单测可选。

---

### Step B —— OCR → UIA 邻域匹配 + fallback 梳理（依赖 A 的字段）

**改动文件：`src/tools/desktop-tools.ts` + `src/scripts/ocr-worker.ps1`（如需）**

B1. OCR 不直点：Phase 2（desktop-tools.ts:758-801）
   - 当前：OCR 文本框中心直接作为元素加入 `$filtered`（行 787，`Src='OCR'`）。
   - 改为：对每个 OCR bbox，在 UIA 树中查找 bbox 邻域内的可执行元素（命中 pattern 的 UIA 节点）；
     命中 → 用该 UIA 元素替代 OCR 项（`Src='OCR→UIA'`，坐标用 UIA 中心）；
     未命中可信 UIA → 保留 OCR 坐标项（`Src='OCR'`）作为最后手段。
   - 邻域判定：OCR 中心落在某 UIA 元素 bounds 内，或距离 < 阈值且该 UIA 有 pattern。

B2. fallback 顺序固化（click_element，约 1128-1240）
   - 顺序：UIA pattern（`tryUiaAction`）→ UIA 坐标 HID → OCR 邻域得到的 UIA → 纯坐标。
   - `visionLocate` 路径（vision-grounding.ts，约 1151-1185）保留为「无任何可信 UIA」时兜底。

B3. 编号兼容
   - OCR / OCR→UIA 结果仍进同一 numbered list（`screenshotMetaMap`），`click_element(number)` 行为不变。

**B 的门禁**：build + test；关注 `tests/e2e/` 中 OCR 相关用例（当前缺 Windows OCR 专项，B 末尾补一条 fixture 级断言）。

---

### Step C —— 动作后验证 + keyboard 精准化（依赖 A/B 完成）

**改动文件：`src/tools/desktop-tools.ts`（+ 复用 provider.ts 的回读 PowerShell 片段）**

C1. 统一 post-action verification helper
   - 新增 TS helper（desktop-tools.ts 内），动作后跑一段 PowerShell 回读目标 UIA 状态，
     直接移植 `provider.ts:858-882` 的状态读取（Value/IsSelected/ToggleState/ExpandCollapseState/HasKeyboardFocus）
     与 `provider.ts:520-537` 的比较逻辑（before/after 对比）。
   - 状态枚举：`verified` / `state_not_changed` / `needs_resnapshot` / `uncertain`。

C2. click 后验证（`tryUiaAction` 432-455 与 `click_element` 返回前 ~1207/1232）
   - button：UI 变化 / 目标消失 / 新目标出现；checkbox/toggle：ToggleState 变；
     expand：ExpandCollapseState 变；list/tab：IsSelected 变。
   - 失败返回上述状态而非盲目 success。

C3. keyboard_type 精准化（约 1517-1598）
   - 优先级：`ValuePattern.SetValue`（现有 tryUiaAction setValue 已实现）→ focus 后输入 → `SendKeys` 兜底。
   - 输入后验证 Value/文本/焦点。

C4. 返回 schema
   - MCP 返回当前是纯 text（`{content:[{type:'text',text}]}`）。在 text 中附结构化状态行；
     若要结构化字段，扩展 `types.ts` 的 VerificationResult 风格 schema（评估后决定，避免过度改动）。

**C 的门禁**：build + test；`computer-use/core/__tests__/runtime.test.ts` 已覆盖 verifyAction，补 desktop-tools 路径用例。

---

## 验证与回归（贯穿）

- 每步：`cd mcps/spectrai-claw && npm run build && npm run test:computer-use`。
- 真机「截图→点击→输入」smoke 经 spectrai-agent 网关跑不通（PowerShell unavailable，已知环境限制）；
  需用户在本地 Windows 桌面会话直连 MCP 验证。
- 完成后在 `docs/computer-use-windows.md` 追加准确性改造说明 + 指标口径
  （首次命中率 / 原生 pattern 成功率 / OCR 触发率 / HID fallback 比例 / 动作后验证成功率）。

## 非目标（沿用 mission plan）

非 Windows 平台、Swift daemon 大迁移、纯视觉执行器替换、与目标无关的大重构。
