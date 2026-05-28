# SpectrAI Claw —— 借鉴 trycua/cua 的操作准确性增强 · 实施规划

> 目标：在不破坏现有 Windows UIA 主链路可用性的前提下，分阶段引入 cua 验证过的三类能力：
> ① 视觉 grounding 兜底（填补 UIA 盲区）、② 轨迹录制 + benchmark 准确率回归、③ 科幻感操作可视化 HUD。
> 本文档基于对 `mcps/spectrai-claw/src/` 的实际代码精读，所有改动点标注真实文件/行号；推测部分明确标注「待核实」。

---

## 0. 关键架构事实（已核实，决定一切落地点）

精读后确认 SpectrAI Claw 内部存在**两条平行的操作链路**：

| 链路 | 入口 | 路径 | 现状 |
|---|---|---|---|
| **A. MCP 工具直连链路（生产实际在用）** | `src/tools/desktop-tools.ts` | 直接拼 PowerShell 脚本调 UIA/Win32/GDI | `screenshot` / `click_element` / `mouse_click` / `keyboard_*` / `window_*` 全在这；**不 import** runtime/registry/WindowsComputerUseProvider（已 grep 确认无引用） |
| **B. computer-use runtime/provider 框架链路** | `src/computer-use/core/runtime.ts` `executeAction` + `registry.ts` | provider 优先级路由 + action-then-verify + fallback chain | 设计完整，但生产 `src/index.ts` **未把 `WindowsComputerUseProvider` 注册进 `defaultProviderRegistry`**；目前主要 browser provider 在用，Windows provider 已实现但未被主线消费 |

**结论（重要纠偏）**：
- registry 的 fallback chain（`runtime.ts:301-344`，`findElement` 返回 null 即 `continue` 到下一 provider）**只在链路 B 内生效**。
- 因此「视觉 grounding 兜底」若只加一个 vision provider 注册到 registry，**不会影响 Windows 实际的 `click_element`**——因为它走链路 A，根本不经过 runtime。
- 这是研究阶段一个乐观假设的纠正点：**P0 必须落在链路 A（`desktop-tools.ts` 的失败分支），才能让 Windows 真实操作受益。**

---

## 1. 已核实的代码事实清单

- `registry.ts:13-20` `PROVIDER_KIND_PRIORITY`：`browser=500 / os-accessibility=400 / app-bridge=300 / vision-ocr=200 / hid=100`。
- `registry.ts:102-141` `route()`：按 kind 优先级排序候选，`allowFallback` 默认 true。
- `runtime.ts:301-344`：candidate 循环，`findElement→null` 或 `result.ok=false` 时 `continueOnProviderFailure`(默认 true) 触发下一候选。
- `providers/` 下**无 vision 目录**；已有 windows / macos / browser 三类。
- `providers/windows/index.ts` 导出 `WindowsComputerUseProvider`，但未在 `index.ts` 注册到 defaultProviderRegistry。
- 测试基建已就位：`tests/computer-use/run-computer-use-benchmark.mjs`、`generate-canonical-report.mjs`、`report-schema.json`、`windows-computer-use-fixture.test.mjs`、`tests/e2e/computer-use-report.test.mjs`。
- 已有视觉兜底相关 fixture 雏形：`tests/computer-use/fixtures/vision-fallback-canvas.html`、`fixtures/browser/canvas-fallback-fixture.html`。
- `package.json`：`build = tsc + 复制 src/scripts/*.ps1 → dist/scripts/`；`test:computer-use` 跑 dist 单测 + 三个 mjs；**无 sharp/jimp/canvas 等图像库依赖**（HUD 绘制走 PowerShell GDI+）。
- OCR：`src/scripts/ocr-worker.ps1`（STA 进程，Windows.Media.Ocr），输出 `text|screenX|screenY|width|height` 行格式；`desktop-tools.ts` 已用它做 OCR 补充标注。
- `screenshot` 元数据存在内存 `screenshotMetaMap: Map<path, ScreenshotMeta>`（`desktop-tools.ts:64-77`），含 `elements: AnnotatedElement[]`（`:48-62`，字段 number/name/controlType/screenX/screenY/rect*）；**session 结束即丢失**。
- `click_element(number)`（`desktop-tools.ts` ~1050-1153）：查 metaMap → 优先 UIA 原生动作(Invoke/Toggle/Selection/Focus) → 失败回退 HID `mouse_event` → 验证截图。
- `SoMRenderer.ts`：仅 MCP 内容适配（图→base64→MCP content blocks），**不做图像绘制**；真正的标注绘制在 `desktop-tools.ts` 的 PowerShell GDI+ 段（~800-847）。
- `verification.ts` + `types.ts:241-251` `VerificationResult{ ok, mode, element?, state?, message? }`，`ElementNode.bounds{x,y,w,h}`——断言通过率与 HUD 高亮的数据来源。

---

## 2. 三个工作流的并行性与冲突分析

| 工作流 | 主战场文件 | 与其他流的文件交集 |
|---|---|---|
| **A — 视觉 grounding 兜底** | `desktop-tools.ts`(click_element 失败分支) + 新增 `src/tools/vision-grounding.ts` + 复用 `ocr-worker.ps1` | 与 C 都碰 `desktop-tools.ts` |
| **B — 轨迹 + benchmark** | 新增 `trace*.ts` / `benchmark-metrics.ts` + 改 `runtime.ts` `types.ts` + `desktop-tools.ts`(截图持久化~20行) + `tests/` + `package.json` | 与 A、C 都碰 `desktop-tools.ts`；与 A 都可能碰 `types.ts` |
| **C — 科幻 HUD** | 新增 `src/tools/hud-renderer.ts` + `src/scripts/hud-drawing.ps1` + 在 `desktop-tools.ts` 追加 `render_hud` tool 注册 | 与 A、B 都碰 `desktop-tools.ts` |

**核心冲突点：三个流都要改 `desktop-tools.ts`（2086 行大文件）。**

### 冲突规避策略
1. **逻辑外置**：A 的视觉匹配逻辑放新文件 `vision-grounding.ts`，C 的渲染逻辑放 `hud-renderer.ts` + `hud-drawing.ps1`，二者在 `desktop-tools.ts` 中**只留极小的调用/注册点**。
2. **改动区域分区**：
   - A 改 `click_element` 函数内部失败分支（文件中段）。
   - B 改 `screenshot` 函数返回处（截图持久化）+ 文件中段。
   - C 仅在**工具注册区（文件末尾）**追加 `registerTool('render_hud', ...)`。
3. **隔离执行**：每个 agent 在**独立 git worktree** 实现并各自 `commit`，最后由主会话逐个 review 合并到 `main`，`desktop-tools.ts` 的合并冲突手动解决（三者改动区域不重叠，冲突可控）。
4. **types.ts 协调**：A 若需 vision 相关类型，加在文件尾部独立 section；B 的 `CanonicalReport.trace?` 字段加在 CanonicalReport 定义处——两处不同位置，冲突概率低。

### 推荐执行顺序
- **A、B、C 可并行启动**（各自 worktree）。
- 合并顺序建议 **B → A → C**：B 先合（它对 `runtime.ts`/`types.ts` 的改动是地基，且轨迹数据可被 A 的兜底命中率统计复用）；A 次之；C 最后（纯增量 tool，最不影响其他）。

---

## 3. 工作流 A —— 视觉 grounding 兜底（P0，可用性收益最大）

**目标**：当 Windows UIA 路径定位失败（UIA 树为空 / 编号匹配不到 / Canvas·Electron·RDP·游戏自绘场景），自动用「截图 + OCR/视觉标注 → 文本/位置匹配 → 坐标点击」兜底，让 `click_element` 在无控件树场景下仍能命中。

### 前置必做（Agent A 第一步，禁止跳过）
确认 `desktop-tools.ts` 中 `click_element` 的失败语义：UIA 找不到目标 / UIA 动作失败 / HID 点击后验证截图未变化，分别在哪几行返回什么。**兜底必须接在这些真实失败分支后**，而不是 registry。

### 改动方案
**新增 `src/tools/vision-grounding.ts`**：
- `async function visionLocate(selector: { text?: string; near?: {x,y}; role?: string }, screenshotPath): Promise<{x,y,confidence} | null>`
  - 复用 `ocr-worker.ps1` 拿到 `text|x|y|w|h` 列表 → 按 `selector.text` 做模糊/包含匹配（含大小写、空白归一化），多命中时用 `near` 邻域最近者，返回中心坐标 + confidence。
- 不引入新依赖；纯解析 OCR 输出 + 字符串匹配。

**改 `desktop-tools.ts`**：
- 在 `click_element` 与（可选）`keyboard_type` 的失败分支后插入：调用 `visionLocate` → 命中则 HID 点击该坐标 → 复用现有「验证截图」确认 → 返回时在结果里标注 `method: 'vision-fallback'` 与 `confidence`。
- 新增可选 MCP 工具 `vision_click({ text, near? })`：显式走视觉兜底（给 Claude 一个在 UIA 全失效时的兜底入口）。

**（可选，链路 B 对齐）**：另行将 vision 逻辑包成 `VisionGroundingProvider implements ComputerUseProvider`（kind=`vision-ocr`，platform=windows）注册到 `defaultProviderRegistry`，为未来 desktop-tools 迁移到 runtime 做准备。**本期不要求**，仅在时间充裕时作为 stretch。

### 数据流
```
click_element(n) → UIA 动作失败 / 编号无 →
  screenshot(当前) → ocr-worker.ps1 → 文本/邻域匹配 selector →
  命中(x,y,confidence) → HID mouse_event(x,y) → 验证截图 → 成功
  未命中 → 保持原失败返回（不退化现有行为）
```

### 验收标准
- 现有 UIA 成功路径**零回归**（兜底只在失败后触发）。
- 用 `tests/computer-use/fixtures/vision-fallback-canvas.html`（浏览器 Canvas，无 DOM/UIA 可定位）或本地一个无 UIA 名称的画布程序，验证「按可见文字点击」能命中。
- 兜底命中时返回结构含 `method:'vision-fallback'` 和 confidence，便于 B 的轨迹统计。
- 失败时不抛错、不改变原 UIA 失败语义。

### 风险
- OCR 精度有限（小字/图标无文字）→ 本期只保证「有可见文字的元素」兜底；图标类留待后续接 OmniParser/视觉模型。
- 多命中歧义 → 必须用 `near` 邻域消歧，且 confidence 低于阈值时不自动点击。

---

## 4. 工作流 B —— 轨迹录制 + benchmark 准确率回归（P1+P2）

**目标**：① 在动作执行链路记录结构化轨迹（动作前/后截图路径 + 候选元素 + 动作结果 + 验证结果）；② 基于现有测试基建做一套可重复跑、可比对基线的「定位命中率 / 动作后断言通过率」回归脚本。

### 改动方案
**新增**：
- `src/computer-use/core/trace.ts`：`TraceStep` / `ExecutionTrace` 数据结构 + `TraceRecorder`（startTrace / record* / finalize）。截图**只存路径+元数据，不内联图像 buffer**，避免轨迹文件膨胀。
- `src/computer-use/core/trace-storage.ts`：写入 `.spectrai-traces/<date>/trace-<uuid>.json` + `screenshots/`；`TraceLoader`/`TraceAnalyzer` 读取与统计。
- `src/computer-use/core/benchmark-metrics.ts`：`calculateBenchmarkMetrics(trace)` → `{ elementLocatingAccuracy, postActionVerificationPassRate, fallbackRate, ... }`，指标口径对齐已有 `generate-canonical-report.mjs` 的 `REQUIRED_METRICS`。
- `tests/computer-use/run-local-benchmark.mjs`：跑本地可控场景（记事本输入并断言、计算器点击并断言），算指标。
- `tests/computer-use/detect-benchmark-regression.mjs`：与基线 JSON 比对，跌幅超阈值则非零退出。
- `src/computer-use/core/__tests__/trace.test.ts`：轨迹单测。

**改**：
- `runtime.ts` `executeAction`（`:301-344` 及前后）：在 pre-route / pre-find / post-find / pre-dispatch / post-dispatch / post-verify 挂 `recorder.record*()`；轨迹记录**全程 try/catch 包裹，失败不阻断主流程**（可观测性不能拖垮可用性）。
- `types.ts`：`CanonicalReport` 增加可选 `trace?: ExecutionTrace`（独立位置追加，避开 A 的改动区）。
- `desktop-tools.ts`：`screenshot` 返回处把 `ScreenshotMeta` 落盘一份（供链路 A 兜底命中率统计），改动 ~20 行。
- `package.json` scripts：`benchmark:local`、`benchmark:regression`。
- `.gitignore`：加 `.spectrai-traces/`。

### 验收标准
- `npm run test:computer-use` 全绿（不破坏现有单测/fixture/report 测试）。
- `npm run benchmark:local` 在真实 Windows 上对记事本/计算器场景产出指标 JSON，含 `elementLocatingAccuracy`、`postActionVerificationPassRate`。
- 轨迹文件结构正确，截图分离存储，单条轨迹 JSON < 数百 KB。
- benchmark 运行时间相比基线 ±10% 以内（轨迹开销可控）。
- `detect-benchmark-regression.mjs` 能对人为劣化的数据正确报警（非零退出）。

### 风险
- CI 无 GUI → 截图失败：benchmark 脚本需 `--skip-screenshots` 降级为纯指标。
- 截图磁盘占用：默认 JPEG quality=80，并提供保留天数清理。

---

## 5. 工作流 C —— 科幻感操作可视化 HUD（P4，视觉调性）

**目标**：把元素编号、bbox、动作后断言「命中高亮」渲染成有科幻感的叠层（青色发光描边 / 扫描线 / 半透明信息面板 / 命中脉冲框），作为可视化产物返回。纯叠加在截图图像上，不动真实桌面 UI。

### 改动方案
**新增**：
- `src/scripts/hud-drawing.ps1`：GDI+ 绘制工具函数 `Draw-GlowRectangle`（多层 alpha 描边模拟发光）、`Draw-ScanlineEffect`、`Draw-PulseCircle`、`Draw-InfoPanel`（半透明面板 + 文本）。复用现有 `System.Drawing` 技术栈，**不引入 Node 图像库**。
- `src/tools/hud-renderer.ts`：`renderHud({ imagePath, elements, highlight?, style? })` → 拼 PowerShell 调 `hud-drawing.ps1` → 返回新图路径。`highlight` 来自动作后 `VerificationResult.element.bounds`。

**改**：
- `desktop-tools.ts`：**仅在工具注册区（文件末尾）追加** `registerTool('render_hud', schema, handler)`，handler 调 `hud-renderer.ts`。参数：`screenshotPath`、`highlightNumber?`、`glowColor?`（默认青 `0,200,255`）、`highlightMode?: glow|pulse|flash`。
- `build` 脚本已自动复制 `src/scripts/*.ps1`，新增的 `hud-drawing.ps1` 无需改 build。

### 衔接
- 基础标注链路（screenshot annotate）保持不变。
- 新增「动作后高亮」：`click_element`/verify 拿到命中元素 bounds → 可选调 `render_hud(highlightNumber)` 画发光命中框，作为反馈帧。

### 验收标准
- `render_hud` 对一张截图 + 元素列表，产出带发光框/编号/面板的 PNG，肉眼确认科幻观感。
- 高亮坐标与元素 bbox 对齐（注意：**在缩放前绘制**，避免 maxWidth 缩放导致偏移）。
- 单次 HUD 渲染增量耗时 < 800ms（80 元素级）。
- 不改变 `screenshot` 现有返回，不影响坐标准确性。

### 风险
- 缩放后注解偏移 → 强制在原始分辨率绘制后再缩放，或记录缩放比。
- GDI+ 多层绘制耗时 → 命中高亮只画单个元素的增量层，不重绘全部。

---

## 6. 整体验收与回归门禁

合并任一工作流到 `main` 前必须：
1. `cd mcps/spectrai-claw && npm run build` 通过（tsc 无错）。
2. `npm run test:computer-use` 全绿（现有单测 + fixture + report 测试零回归）。
3. 该工作流自身的验收项（见各节）通过。
4. **真机 smoke**：在真实 Windows 桌面对记事本/计算器跑一遍 `screenshot → click_element → keyboard_type`，确认主链路无回归（这是「保障可用性」的硬性要求）。

---

## 7. worktree 与协作执行计划

- 每个 agent 用独立 worktree（`enter_worktree`）实现，分支命名 `feat/cua-A-vision-fallback`、`feat/cua-B-trace-benchmark`、`feat/cua-C-hud`。
- 各 agent 完成后在自身 worktree `git commit`，**不自动合并**。
- 主会话逐个 review diff → 解决 `desktop-tools.ts` 合并 → 合并到 `main`（顺序 B→A→C）。
- 每次合并后跑第 6 节门禁。

## 8. 明确不做（本期范围外）
- 不引入 Lume/QEMU/Docker 沙箱（与「本地原生即插即用 MCP」定位冲突，且 UIA 白盒路线是 Claw 相对 cua 的核心优势，应强化而非替换）。
- 不引入内置 agent loop（Claw 定位为工具层，规划在 Claude 侧）。
- 不强制把 desktop-tools 迁移到 runtime/registry（架构演进留待后续；本期 P0 直接落在链路 A）。
- 图标/无文字元素的视觉识别（需 OmniParser/视觉模型）留待后续迭代。
