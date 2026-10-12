# E3 合成笔点击路径实验结果

> ## ⚠️ 后续更正（E4，2026-10-12）：`WS_EX_NOACTIVATE` **只对自己创建的窗口有效**
>
> 本文档第 5 节第 5 条说"加 `WS_EX_NOACTIVATE` 后前台全程不变"。E4 把同样的手法用到**别的进程**的窗口（Chrome）上，结果是：样式确实加上了、注入前一刻也确认还在（`noActivateAtInject=true`），但**点击仍然把 Chrome 拉到前台**；对照组（不加样式）表现完全相同。
>
> 反证实验（见 E4 报告 3.4）：把同样的样式**事后**加到自己创建的普通窗口上，前台依然保持不变——所以问题不是"事后加不算"，而是 **Chromium/Electron 在收到指针输入时会自行把窗口拉到前台**。
>
> 结论修正：`WS_EX_NOACTIVATE` 是本进程窗口的有效缓解手段，**不能外推到真实应用**。对真实的 Chromium/Electron 目标，合成笔点击必须默认接受一次前台切换，或改用不依赖激活的机制（如 UIA `Invoke`）。详见 [`../e4-foreign-noactivate/REPORT.md`](../e4-foreign-noactivate/REPORT.md)。
>
> ## ⚠️ 另一条边界（E5 发现）：合成笔**受 UIPI 约束**
>
> E5 安装显示驱动时，Windows 弹出的「Windows 安全中心」对话框由**提升的 `rundll32`** 拥有。用本文档的合成笔点它的「安装」按钮：注入返回 `down=true, up=true`、坐标精确（正是按钮矩形中心），**对话框毫无反应**。
>
> 原因是 UIPI 同样约束输入注入——只能注入到**同等或更低完整性级别**的目标。本文档所有运行的目标都是同级别的，所以没有暴露这个限制。
>
> 实践含义：合成笔不是"万能后台输入"，要按完整性级别分类。对以管理员身份运行的程序，合成笔会被静默丢弃，必须换路径（例如从提升的进程发 `BM_CLICK` / `UIA`）。

- 实验日期：2026-10-12（紧接 E1、E2）
- 机器：Windows 10 19045，两个显示器
- 脚手架：`E3PenClick.ps1`（自建见证窗口 + `CreateSyntheticPointerDevice`/`InjectSyntheticPointerInput`）
- 辅助探针：`MonitorProbe.ps1`（显示器拓扑与 API 可用性，只读）
- 数据：同目录 `e3-result-*.json`

## 1. 目的与判据

E3 假设：合成笔输入能否精确点中目标，并且**不移动系统光标**、**不改变前台窗口**。

| 判据 | 字段 | 通过条件 |
|---|---|---|
| 点击命中 | `witness.hit` | true |
| 坐标精确 | `witness.pts` | 与请求点完全一致 |
| 光标零位移 | `cursor.dx` / `cursor.dy` | 均为 0 |
| 前台窗口全程不变 | `fg.stable` / `fg.distinctDuringRun` | true / 1 |
| 目标确实处于后台 | `park.targetWasForeground` | false（否则该次运行只是前台基准） |

## 2. 方法

**见证窗口**：脚本自己创建一个普通 Win32 窗口当作被测目标，把收到的点击写进**窗口标题**（`SetWindowText`）：

```
E3 down=<鼠标消息数> up=<...> penDN=<WM_POINTERDOWN 数> penUP=<...> penMV=<...> pts[L<x>:<y>; ...]
```

标题与焦点无关，读回不依赖截图——这是 E2 学到的教训（Chromium/位图在非活动窗口上会撒谎）。窗口默认在运行结束即销毁。

**注入**：`CreateSyntheticPointerDevice(PT_PEN, 1, mode)` + `InjectSyntheticPointerInput`，每个点击由 `DOWN`（`INRANGE|INCONTACT|DOWN|PRIMARY`）和 `UP`（`INRANGE|UP`）两次注入组成，坐标是**虚拟屏像素坐标**。不用 `SendInput`、不用 `mouse_event`、不移动光标。

**进程 DPI 感知**：进入时设置 `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`，否则像素坐标会被虚拟化。

**测量**：独立线程每 ~2 ms 采样 `GetCursorPos` 与 `GetForegroundWindow`；`park` 机制同 E1/E2（把前台让给另一个窗口，并用 `GetForegroundWindow` 回读校验）。

## 3. 环境事实（`MonitorProbe.ps1`）

```
monitors: 2
  monitor=[0,0 - 1536,864]      work=[0,0 - 1536,824]      primary=True
  monitor=[1920,0 - 3840,1080]  work=[1920,0 - 3840,1040]  primary=False
```

- 两块屏之间在 x=1536…1920 有一段**坐标空隙**（各次运行的鼠标都在 (1845,725)，落在空隙里，全程未动）。
- `user32!CreateSyntheticPointerDevice` / `InjectSyntheticPointerInput` 都存在。
- `CreateSyntheticPointerDevice` 取值扫描：`PT_TOUCH(2)` 与 `PT_PEN(3)` 在 `mode` 1/2/3 下都能创建；**`mode=0` 一律 `ERROR_INVALID_PARAMETER(87)`**；`PT_MOUSE(4)` 任何 mode 都失败（符合设计：鼠标不能这样合成）。
- 机器上**已装 3 个虚拟显示适配器驱动**：`GameViewer Virtual Display Adapter`、`MuMu Virtual Display Adapter`、`OrayIddDriver Device`（状态 OK），但**没有任何一个当前作为显示器启用**——当前只有那两块物理屏。

## 4. 结果

| 运行 | 见证窗口位置 | 点击点 | `WS_EX_NOACTIVATE` | park | 目标在前台 | 命中 | 收到坐标 | 光标 | 前台 |
|---|---|---|---|---|---|---|---|---|---|
| A | 100,100（主屏） | 450,300 | 否 | 未请求 | **是**（基准） | ✅ | `L450:300` | 0×0 | 稳定 |
| A′ | 100,100（主屏） | 450,300 | 否 | 未请求 | 是（基准） | ✅ | `L450:300` | 0×0 | 稳定 |
| B | 100,120（主屏） | 450,300 | 否 | ok | 否 | **❌ 未命中** | — | 0×0 | 稳定 |
| B2 | 2400,200（副屏） | 2700,350 | 否 | ok | 否 | ✅ | `L2700:350` | 0×0 | **改变**（`distinct=3`） |
| B2′ | 2400,200（副屏） | 2700,350 | 否 | ok | 否 | ✅ | `L2700:350` | 0×0 | **改变** |
| **B3** | 2400,200（副屏） | 2700,350 | **是** | ok | 否 | ✅ | `L2700:350` | 0×0 | **稳定**（`distinct=1`） |
| B3′ | 同 B3 | 2700,350 | 是 | ok | 否 | ✅ | `L2700:350` | 0×0 | 稳定 |
| B3″ | 同 B3 | 2700,350 | 是 | ok | 否 | ✅ | `L2700:350` | 0×0 | 稳定 |
| B4 | 2400,200（副屏） | **2500,250 ×3 次** | 是 | ok | 否 | ✅ ×3 | `L2500:250;L2500:250;L2500:250;` | 0×0 | 稳定 |

## 5. 结论

1. **合成笔点击命中精确，且可重复。** 请求什么坐标就收到什么坐标（`450:300`、`2700:350`、连点三次 `2500:250` 全部一致），三次重复运行结果完全相同。这满足判据「点击命中率不低于前台路径」。
2. **系统光标全程零位移。** 所有运行 `cursor.dx=dy=0`，包括鼠标停在两块屏坐标空隙里的情况。合成笔完全不碰真光标。
3. **后台窗口能收到笔点击**（B2/B3：`park=ok`、`targetWasForeground=false`、仍然 `hit=true`）。这一点和键盘路径不同——键盘消息要先让目标「自认激活」，笔点击是按坐标直接投递的。
4. **但默认会抢前台。** 不加任何处理时，点击会激活目标窗口：B2 的 `fg.stable=false`、`distinctDuringRun=3`、前台从 SpectrAI 变成了见证窗口。**这正是研究文档里列出的证伪条件**，实测确实成立。
5. ~~**`WS_EX_NOACTIVATE` 是有效且低代价的缓解。**~~ **仅对本进程创建的窗口成立，见文首更正。** 加上之后（B3/B3′/B3″/B4）：命中不变、坐标不变、光标仍为 0，而**前台窗口 `distinctDuringRun=1`、全程未变**。E4 证明这对别的进程的 Chromium 窗口无效。
6. **遮挡限制成立。** B 那次点击点 (450,300) 落在 SpectrAI 主窗口（rect `-7,-7 – 1543,831`）之内，见证窗口因此**什么都没收到**——笔点击落到了压在上面的那个窗口上。这与 Cua Driver 文档里的说法一致：**目标位置不能被别的窗口盖住**，否则需要把目标窗口移到不被遮挡的位置（这就是虚拟屏方案的动机）。

## 6. 未做：虚拟显示器

E3 原本要求"把窗口放到虚拟屏上"。**本次没有安装任何 IddCx 虚拟显示驱动**，而是用真实的第二块显示器完成了跨屏路由与遮挡验证。原因与影响：

- 装驱动是系统级改动（需要管理员权限、驱动签名、可能重启），与本方向"零注入、不动系统设置"的实验纪律相冲突，应当单独征求同意后再做。
- 这台机器上已存在 3 个虚拟显示驱动（见第 3 节），但它们没有启用成显示器——**启用其中一个可能比新装一个更省事**，值得作为下一步先试。
- 用真实副屏的差别：真实屏是**用户看得见**的，而且屏上的窗口仍可能被其他窗口遮挡；虚拟屏的核心价值是"看不见 + 不会被遮挡"，这两点本次没能验证。

## 7. 已知缺陷与局限

- **一次误点落在 SpectrAI 窗口内**（运行 B，点 (450,300)，当时该点被 SpectrAI 覆盖）。前台没有变化、没有出现新窗口或对话框，我没有看到可见后果，但**确实有一次点击进了 SpectrAI 的界面**。后续所有运行都改到副屏无遮挡位置，并加了 `-NoActivate`。
- **只测了 `PT_PEN`**：`PT_TOUCH` 只验证了"能创建设备"，没测命中行为。
- **只测了自己的进程**：见证窗口是本进程创建的，`WS_EX_NOACTIVATE` 是在**创建时**加的。**没有测**对别的进程的既有窗口用 `SetWindowLong(GWL_EXSTYLE)` 临时加该样式（Cua Driver 的做法），这是下一个关键未知。
- **未测**：`WS_EX_NOACTIVATE` 目标上的输入框能否正常获得键盘焦点（但这与 E2 的后台键盘路径合起来才有意义）、最小化窗口、DPI 缩放的第二屏坐标换算、鼠标右键/拖动、多点按住。
- **`WM_LBUTTON*` 计数为 0**：见证窗口收到的全是 `WM_POINTER*` 消息，没有被提升为鼠标消息。因此本实验**没有验证**"对只认鼠标消息的传统程序是否同样有效"。
- `FeedbackMode` 用 1（`POINTER_FEEDBACK_DEFAULT`）时理论上会有视觉反馈涟漪；本次没去观察它对用户视觉干扰的实际程度。

## 8. 复现

```bash
cd experiments/e3-pen-click

# 只读探针：显示器拓扑 + API 可用性 + 取值扫描
powershell -NoProfile -ExecutionPolicy Bypass -File MonitorProbe.ps1

# 前台基准（见证窗口自己在前台）
powershell -NoProfile -ExecutionPolicy Bypass -File E3PenClick.ps1 -Mode run -X 100 -Y 100 -W 700 -H 400 -NoPark

# 后台 + 缓解：见证窗口在副屏，前台让给 SpectrAI
powershell -NoProfile -ExecutionPolicy Bypass -File E3PenClick.ps1 -Mode run \
  -X 2400 -Y 200 -W 600 -H 300 -ParkProc SpectrAI -NoActivate

# 指定点击点与连点次数
powershell -NoProfile -ExecutionPolicy Bypass -File E3PenClick.ps1 -Mode run \
  -X 2400 -Y 200 -W 600 -H 300 -ClickX 2500 -ClickY 250 -Clicks 3 -ParkProc SpectrAI -NoActivate
```

## 9. 建议的下一步

1. **跨进程 `WS_EX_NOACTIVATE`**：对**别人的**窗口用 `SetWindowLongPtr(hwnd, GWL_EXSTYLE, | 0x08000000)` 临时加样式、用完还原，验证"对真实应用的后台点击不抢前台"能否同样成立（Cua Driver 正是这么做的）。这是把 E3 从"自建窗口"推向"真实应用"的第一步。
2. **虚拟屏**：优先尝试启用已存在的三个虚拟显示驱动之一；不行再考虑装 IddCx。必须先解决"目标点被遮挡"这个已实测的硬限制。
3. **`PT_TOUCH` 对照**：触控合成对只认鼠标消息的传统程序是否更兼容（`WM_LBUTTON*` 至今为 0）。
4. **把 E2 + E3 拼起来**：后台点击聚焦输入框 → 后台键盘输入，验证一条完整的"零干扰操作链"。
