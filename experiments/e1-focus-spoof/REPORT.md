# E1 焦点伪造 / 后台投递 可行性实验结果

- 实验日期：2026-10-12
- 机器：Windows 10 19045，单会话
- 脚手架：`E1FocusSpoof.ps1`（PowerShell + 内联 C#，纯 Win32 消息，无注入、无钩子）
- 结果原始数据：同目录 `e1-result-*.json`（每次运行一个文件，含逐次采样明细）
- 汇总表：`node summarize.js`

## 1. 目的与判据

E1 假设：**不注入 DLL、不装全局钩子、不动光标**，只向目标窗口的消息队列投递消息（激活伪造 + 键盘消息），能否把文字送进「非前台窗口」的输入控件。

| 判据 | 字段 | 通过条件 |
|---|---|---|
| 文字完整到达 | `textArrived` | true，且与载荷逐字符相等 |
| 前台窗口全程不变 | `fg.distinctDuringRun` / `fg.stable` | 恒为 1 且等于运行前的前台窗口 |
| 光标零位移 | `cursor.dx` / `cursor.dy` | 均为 0 |

## 2. 方法

**注入序列**（`-NoSpoof` 可关）：

```
WM_NCACTIVATE(top, TRUE)  ->  WM_ACTIVATE(top, WA_ACTIVE)  ->  WM_SETFOCUS(control)
```

**字符投递** `-CharMode`：

| 模式 | 行为 | 说明 |
|---|---|---|
| `char` | 只发 `WM_CHAR` | 标准控件的正确姿势 |
| `keydown` | 只发 `WM_KEYDOWN` | 由目标消息循环的 `TranslateMessage` 生成 `WM_CHAR` |
| `both` | 两者都发 | v1 的写法，在标准控件上会重复插入 |

**测量**（单进程、无钩子）：

- 独立线程每 ~2 ms 采样 `GetCursorPos` + `GetForegroundWindow`（运行期间临时 `timeBeginPeriod(1)`）
- `WM_GETTEXT` 读控件文本，跨进程可用（标准控件）
- Chromium 无文本通道，改用 `PrintWindow(PW_RENDERFULLCONTENT)` 前后两帧位图差异：单像素三通道差之和 > 30 记为变更像素，并给出变更包围盒

**park 机制**：运行前把另一个窗口（本次用 SpectrAI）切到前台，确保目标确实处于后台；随后用 `GetForegroundWindow` 回读校验，并把 `targetWasForeground` / `conclusive` 写进结果。`-ParkSelf` 是反向对照：故意把目标自己切到前台。

**隔离与安全边界**：

- Chromium 目标用**独立 `--user-data-dir` 新开的 Chrome 实例**，页面是本地 `chromium-target.html`（一个 `autofocus` 的 input）
- 全程没有把微信作为目标，没有触碰用户既有浏览器会话的数据
- 没有 DLL 注入、没有 `AttachThreadInput`、没有 `SendInput`、没有全局钩子、没有改系统设置

## 3. 结果

| 运行 | 目标 | 投递给 | 模式 | park | 目标在前台 | 光标 | 前台稳定 | 变更像素 | 包围盒 |
|---|---|---|---|---|---|---|---|---|---|
| 144059 | notepad `Edit` | Edit | `char` | ok | 否 | 0×0 | 稳定 | — | — |
| 144121 | notepad `Edit` | Edit | `keydown` | ok | 否 | 0×0 | 稳定 | 1438 | 291,51-646,502 |
| 144225 | SodaMusic | 顶层窗口 | `keydown` | ok | 否 | 0×0 | 稳定 | 0 | — |
| 144232 | SodaMusic | 顶层窗口 | `char` | ok | 否 | 0×0 | 稳定 | 0 | — |
| **144454** | chrome（自建 profile） | RenderWidget | `both` | self-ok | **是** | 0×0 | 稳定 | **14606** | **84,185-1199,240** |
| 144458 | chrome（自建 profile） | RenderWidget#2 | `both` | self-ok | 是 | 0×0 | 稳定 | 1323 | 90,194-1123,229 |
| 144503 | chrome（自建 profile） | 顶层窗口 | `both` | self-ok | 是 | 0×0 | 稳定 | 1895 | 119,194-1150,229 |
| 144520 | chrome（自建 profile） | RenderWidget | `both` | ok | 否 | 0×0 | 稳定 | 2661（整窗弥散，未复现，判为重绘噪声） | 8,0-1199,399 |
| 144526 | chrome（自建 profile） | RenderWidget#2 | `both` | ok | 否 | **36×46** | 稳定 | 0 | — |
| 144543 | chrome（自建 profile） | RenderWidget | 空载荷对照 | ok | 否 | 0×0 | 稳定 | 0 | — |
| **144549** | chrome（自建 profile） | RenderWidget | `both` | ok | 否 | 0×0 | 稳定 | **0** | — |

记事本（144059）读数：`beforeLen=0 → afterLen=30`，`arrivedText = E1-FOCUS-SPOOF-TEST-0123456789`，与载荷**逐字符相等**。

## 4. 结论

1. **Win32 标准控件（记事本 Edit）：后台投递成立。** 三条判据全过——文字完整到达、前台窗口 1688 ms 内 868 次采样全部是同一个窗口、光标位移 0。投递方式是 `WM_CHAR`（`-CharMode char`）。
2. **`WM_KEYDOWN` 会丢大小写。** 144121 虽然也把文字送进了后台记事本，但全部变成小写（`e1-focus-spoof-test-...`）：只发 `WM_KEYDOWN` 时修饰键状态为空，`TranslateMessage` 生成的是小写字符。后台打字要保真，必须发 `WM_CHAR`。
3. **Chromium（Chrome）前台能投、后台不能投。** 同一个 hwnd、同一套序列，前台时变更像素 14606 且**变更包围盒正好落在输入框那一行**（y 185–240，页面里 input 就在那里）；一切换到后台，重复两次都是 **0 变更像素**，空载荷对照同样是 0，说明这不是「载荷没生效」而是「消息被静默丢弃」。
4. **Electron（汽水音乐）的 0 变更不作为负结论。** 无法确认它的界面里当时存在聚焦的输入框，读数通道也不可用（无 `WM_GETTEXT`、位图对比对 UI 状态变更不敏感），记为「不构成证据」。
5. **对研究方向的意义：E1 没有推翻「第二焦点」的必要性，反而把它定位成唯一缺口。** 结论是——Chromium 只在它自己认为窗口处于激活时才接收键盘消息；单纯往消息队列投递 `WM_NCACTIVATE`/`WM_ACTIVATE`/`WM_SETFOCUS` **不足以改变 Chromium 线程内部对「我是否激活」的判断**。这正是研究文档里标注为 C 级假设的那一环，现在从假设变成了实测缺口。

## 5. 已知缺陷与局限（都影响结论强度，如实列出）

- **「不干扰」是间接证明**：没有安装低层输入钩子去区分真实输入与模拟输入，判据只有「光标位移 0」+「前台窗口不变」两个指标。这也意味着该脚手架不含任何键盘监听代码。
- **Chromium 没有文本读数**：只能看像素变化，「局部化在输入行」是判读依据，不是文本内容的证明。更硬的验证需要一个能从外部读取渲染进程 DOM 的通道（CDP 或 UIA），本次没做。
- **一次运行光标动了**（144526，dx=36 dy=46）：来源不可判定（可能是任何真实输入，也可能是别的会话），该记录保留但标注受污染，不用于结论。
- **两次运行打错了目标**（144347 / 144352）：把用户自己 Chrome 的「朱批」标签页当成了目标（标题长度撞车）。该目标在两轮里都是 0 变更像素，没有可见影响；此处仅作记录，提醒后续必须按精确 hwnd 定位。
- **144520 的 2661 像素是噪声**：包围盒铺满整窗，且用同样参数重复两次均为 0，判为窗口重绘，不作为「后台投递成功」的证据。
- **未覆盖**：最小化窗口、中文输入法/`WM_IME_*`、快捷键（属于 E2）、DPI 缩放、多显示器坐标偏移。

## 6. 复现

```bash
cd experiments/e1-focus-spoof

# 列出窗口、类名、子控件（写 windows.json，UTF-8）
powershell -NoProfile -ExecutionPolicy Bypass -File E1FocusSpoof.ps1 -Mode list -TargetProc 'notepad|chrome'

# Win32 标准控件：后台投递（park 到 SpectrAI 让目标落在后台）
powershell -NoProfile -ExecutionPolicy Bypass -File E1FocusSpoof.ps1 -Mode run `
  -TargetProc notepad -ChildClass '^Edit$' -CharMode char -ParkProc SpectrAI

# Chromium：自建 profile 开一个带 autofocus input 的本地页面
"C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir=%TEMP%\e1-chrome-profile --no-first-run --window-size=1200,400 `
  "file:///<abs-path>/chromium-target.html"

# Chromium 前台对照 / 后台对照（按精确 hwnd）
powershell -NoProfile -ExecutionPolicy Bypass -File E1FocusSpoof.ps1 -Mode run `
  -TargetHwnd <chrome-hwnd> -InjectHwnd <renderwidget-hwnd> -CharMode both -ParkSelf   -Snapshot
powershell -NoProfile -ExecutionPolicy Bypass -File E1FocusSpoof.ps1 -Mode run `
  -TargetHwnd <chrome-hwnd> -InjectHwnd <renderwidget-hwnd> -CharMode both -ParkProc SpectrAI -Snapshot

node summarize.js     # 汇总所有 e1-result-*.json
```

## 7. 建议的下一步

1. **E2（后台快捷键）**：对 Chromium 加 `AttachThreadInput` + `SetKeyboardState` 写入 Ctrl 按下，再投递消息，验证后台 `Ctrl+V`/`Ctrl+A`。E1 的结论说明：仅靠消息做不到，E2 就是验证「线程级键盘状态改写」能否补上这一环。
2. **选对 render widget 的规则**：Chrome 一个主窗口下有多个 `Chrome_RenderWidgetHostHWND`，只有一个（144454 对应的那个）真正接收输入，特征就是「产生最大且局部化的像素变化」。应把这个探测固化成选控件的第一步。
3. **给 Chromium 装一个硬读数通道**：只靠位图判定强度不够。可选 CDP（受限于目标是否开调试端口）或 UIA（可能需 `--force-renderer-accessibility`）。
4. **E3（虚拟屏 + 合成笔）**：E1 只覆盖了键盘路径；点击路径的零位移能力尚未验证。
