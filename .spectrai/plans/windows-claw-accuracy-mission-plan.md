# SpectrAI Claw Windows 操作准确性改造计划

## 目标

提升 `mcps/spectrai-claw` 在 Windows 上的操作准确性，重点解决“找错目标、点错位置、点后无验证”的问题，在不偏离现有 `UIA + OCR + HID fallback` 架构的前提下，把主通道升级为 **UIA 语义定位优先、视觉/OCR 补洞、动作后断言校验**。

## 当前问题判断

基于对以下文件的分析：

- `mcps/spectrai-claw/src/tools/desktop-tools.ts`
- `mcps/spectrai-claw/src/scripts/ocr-worker.ps1`
- `mcps/spectrai-claw/src/helpers/PersistentShell.ts`

当前 Windows 链路存在这些核心问题：

1. **候选元素筛选过宽**
   - UIA 标注阶段把较多弱候选一起暴露给上层。
   - 缺少对容器、图片、父子重复节点、弱标签节点的强过滤与强降权。

2. **选目标层偏“编号点击”**
   - `click_element(number)` 依赖截图编号，语义信息利用不充分。
   - 已有 `uia_find_element` 这类语义入口，但未成为主工作流。

3. **OCR 结果过于接近执行层**
   - OCR 识别的是“文字框”，不等于真正可操作控件。
   - 容易把文本中心当点击中心，导致误点。

4. **动作后缺少状态验证**
   - 当前更多是“发出了动作”，较少验证“目标状态是否真的发生变化”。
   - 误点、无效点击、焦点偏移都可能被误判为成功。

5. **Web / Electron / Chromium 场景缺少专门策略**
   - 这类场景对纯 UIA 不稳定，对 OCR 又容易误点。
   - 需要更清晰的 backend 策略与 fallback 顺序。

## 改造原则

1. **UIA 主定位**
   - 标准 Windows 控件优先走 UIA 语义定位和 control pattern。

2. **OCR / 视觉只做补洞**
   - OCR 负责发现文本线索，不直接作为最终点击依据。

3. **selector 优于编号**
   - 从“点编号”逐步升级到“按 selector / query 找元素并执行”。

4. **执行后必须验收**
   - 点击、输入、切换状态后，必须通过属性/状态/焦点变化验证成功。

5. **保持现有架构渐进升级**
   - 先改 `desktop-tools.ts` 的识别、匹配、验证逻辑，再决定是否抽 native helper。

## 目标方案

### Phase 1：识别层与选目标层加固（最高优先级）

#### 1. UIA 候选过滤与打分

在 `desktop-tools.ts` 的 UIA 标注阶段加入：

- 只保留可见、可用、边界合理的节点
- 对支持 pattern 的元素显著加权：
  - `InvokePattern`
  - `TogglePattern`
  - `SelectionItemPattern`
  - `ExpandCollapsePattern`
  - `ValuePattern`
- 对下列情况降权或过滤：
  - 纯 `Image`
  - 过大容器
  - 过小噪声节点
  - 父子重复节点
  - 空标签且无 pattern 的节点

输出从“平铺编号列表”升级为“按可操作性排序的候选列表”。

#### 2. selector / query 主工作流

在保留 `click_element(number)` 兼容的前提下，新增并强化：

- 语义查询点击
- 基于 `name / automationId / className / controlType / processId` 的 selector
- 歧义结果返回候选集，不直接猜一个执行

优先级：

`AutomationId > 精确 Name + ControlType > 结构化 query > number`

#### 3. OCR 与 UIA 的邻域匹配

OCR 结果不直接点中心，而是：

- 先拿 OCR 文本框作为线索
- 在附近 UIA 树中寻找可执行元素
- 命中时，执行落到 UIA 元素
- 仅当没有任何可信 UIA 候选时，才退回坐标点击

### Phase 2：动作执行与动作后验证

#### 4. click 后状态验证

为点击动作增加统一的 post-action verification：

- 按钮：界面是否发生变化 / 目标是否消失 / 新目标是否出现
- checkbox / toggle：`ToggleState` 是否变化
- 展开控件：`ExpandCollapseState` 是否变化
- list/tab：`IsSelected` 是否变化
- 输入框：`HasKeyboardFocus` 或值是否变化

验证失败时返回：

- `uncertain`
- `needs_resnapshot`
- `state_not_changed`

而不是简单返回成功。

#### 5. keyboard_type 精准化

输入优先级：

1. `ValuePattern.SetValue`
2. 目标 focus 后再输入
3. `SendKeys` 兜底

并在输入后验证：

- `Value`
- 文本内容
- 焦点状态

### Phase 3：场景化 backend 策略

#### 6. Windows 场景路由

按应用类型明确策略：

- Win32 / WPF / WinForms：UIA 主通道
- Electron / Chromium 窗口 chrome 区：UIA
- Electron / Chromium 内容区：预留 CDP / 专线入口
- 自绘 / canvas / 图标区：OCR / 视觉 fallback

先在现有代码里把策略路由留好，不在第一轮强行大重构。

### Phase 4：验证与回归

#### 7. 基准用例

补 Windows 准确率验证用例，至少覆盖：

- 普通按钮点击
- checkbox / radio / toggle
- tab / list item
- 文本输入框
- 下拉展开
- 弹窗出现与附着
- Electron/网页型弱 UIA 场景

建议统计指标：

- 首次命中率
- 原生 pattern 成功率
- OCR 触发率
- HID fallback 比例
- 动作后验证成功率

## 建议团队拆分

### Agent A：UIA 识别与 selector

负责：

- `desktop-tools.ts` 中 UIA 候选过滤
- 候选打分
- selector / query 工作流
- 歧义结果处理

### Agent B：OCR 融合与 fallback

负责：

- OCR 文本与 UIA 邻域匹配
- OCR 不直点策略
- fallback 顺序梳理
- 编号点击兼容保留

### Agent C：动作后验证与测试

负责：

- click / type 后状态验证
- 测试用例补充
- 准确率验证与回归说明

## 建议实施顺序

1. 先做 UIA 候选过滤和打分
2. 再做 selector / query 点击主通道
3. 再做 OCR → UIA 邻域匹配
4. 再做动作后验证
5. 最后补测试与准确率验证

## 非目标

本轮不做：

- 非 Windows 平台改造
- Swift daemon 式大迁移
- 与核心目标无关的大规模架构重写
- 纯视觉主导的全新执行器替换

## 预期产出

1. Windows 识别/点击链路代码改造
2. 更稳定的 selector / query 主工作流
3. OCR 只补洞、不直接主导点击
4. 动作后验证机制
5. 基准测试与准确率验证结果
