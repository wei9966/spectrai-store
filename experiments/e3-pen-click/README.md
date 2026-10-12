# E3 合成笔点击实验脚手架

对应研究方案里的 **E3**：用 `CreateSyntheticPointerDevice(PT_PEN)` + `InjectSyntheticPointerInput`，验证**非前台**窗口能否被精确点中，同时不移动光标、不改变前台窗口。

- 结论与全部数据：见 [`REPORT.md`](REPORT.md)
- 结论速览：**命中精确、光标零位移、后台可命中；但默认会抢前台，加 `WS_EX_NOACTIVATE` 后消除。**

## 文件

| 文件 | 作用 |
|---|---|
| `E3PenClick.ps1` | 全部逻辑。自建见证窗口 + 合成笔注入 + 采样。**故意 100% ASCII**（PS 5.1 用 ANSI 代码页解析无 BOM 的 .ps1） |
| `MonitorProbe.ps1` | 只读探针：显示器拓扑、`CreateSyntheticPointerDevice` 可用性与 `(pointerType, mode)` 取值扫描、已装虚拟显示驱动清单 |
| `e3-result-*.json` | 每次运行的原始结果，含逐步日志与采样数 |

## 见证窗口：为什么标题就是读数

脚本创建一个普通 Win32 窗口当被测目标，把收到的点击写进**窗口标题**：

```
E3 down=0 up=0 dbl=0 penDN=1 penUP=1 penMV=1 pts[L2700:350/...]
```

`SetWindowText` 与焦点无关，读回不需要截图。E1 的教训是位图读数在非活动窗口上会系统性撒谎（Chromium 不重绘），所以这里从一开始就不依赖像素。

窗口默认在运行结束即销毁；`-KeepWindow` 可以留下来看。

## 安全边界

只用文档化接口：`RegisterClassEx`/`CreateWindowEx`、`CreateSyntheticPointerDevice`/`InjectSyntheticPointerInput`、`GetCursorPos`、`GetForegroundWindow`、`SetForegroundWindow`/`SwitchToThisWindow`、`PeekMessage`/`DispatchMessage`。

明确**不含**：`SendInput`、`mouse_event`、光标移动、DLL 注入、全局钩子、注册表或系统设置修改、**不安装任何虚拟显示驱动**。

> ⚠️ 合成笔点击是**真实点击**。如果点击坐标被别的窗口盖住，点击会落到那个窗口上（已实测）。请始终给 `-X/-Y` 选择不被遮挡的位置，且先用见证窗口确认命中再对真实应用使用。

## 环境事实（本机实测）

| 项 | 值 |
|---|---|
| 显示器 | 2 块：主屏 `0,0–1536,864`；副屏 `1920,0–3840,1080` |
| `PT_PEN(3)` / `PT_TOUCH(2)` | `mode` 1/2/3 都能创建设备；`mode=0` 报 87（非法参数） |
| `PT_MOUSE(4)` | 任何 mode 都失败 |
| 已装虚拟显示驱动 | GameViewer / MuMu / Oray 三个（状态 OK，但均未启用为显示器） |

## 快速用法

```powershell
.\MonitorProbe.ps1          # 只读：拓扑与 API 可用性

# 前台基准
.\E3PenClick.ps1 -Mode run -X 100 -Y 100 -W 700 -H 400 -NoPark

# 后台 + 缓解（推荐组合）
.\E3PenClick.ps1 -Mode run -X 2400 -Y 200 -W 600 -H 300 -ParkProc SpectrAI -NoActivate
```

参数：`-X/-Y/-W/-H`（见证窗口）、`-ClickX/-ClickY`（点击点，-1 = 窗口中心）、`-Clicks`、`-PointerType 2|3`、`-FeedbackMode 1|2|3`、`-NoActivate`、`-ParkProc/-ParkClass/-ParkTitle`、`-NoPark`、`-KeepWindow`、`-SettleMs`。

## 结果矩阵（详见 REPORT.md）

| 见证窗口 | `WS_EX_NOACTIVATE` | 目标在前台 | 命中 | 坐标 | 光标 | 前台 |
|---|---|---|---|---|---|---|
| 主屏 100,100 | 否 | 是 | ✅ | `L450:300` | 0×0 | 稳定 |
| 主屏 100,120（被 SpectrAI 遮挡） | 否 | 否 | ❌ | — | 0×0 | 稳定 |
| 副屏 2400,200 | 否 | 否 | ✅ | `L2700:350` | 0×0 | **被抢** |
| 副屏 2400,200 | **是** | 否 | ✅ | `L2700:350` | 0×0 | **稳定** |
| 副屏，连点 3 次于 2500,250 | 是 | 否 | ✅×3 | 三次完全一致 | 0×0 | 稳定 |

两条硬限制：**目标点不能被遮挡**；**不给 `WS_EX_NOACTIVATE` 就会把目标窗口拉到前台**。
