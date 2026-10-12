# E4 跨进程 WS_EX_NOACTIVATE 实验脚手架

对应 E3 的后续问题：**能不能对别的进程里已有的窗口，在运行时加上 `WS_EX_NOACTIVATE`、用完撤掉，并得到"点击不抢前台"的效果？**

- 结论与全部数据：见 [`REPORT.md`](REPORT.md)
- **一句话结论**：机件完全可用（能加、能确认、能还原），但**挡不住 Chromium/Electron 自己抢前台**。

## 文件

| 文件 | 作用 |
|---|---|
| `E4ForeignNoActivate.ps1` | 全部逻辑：读写目标窗口扩展样式 + 合成笔注入 + z 序/preflight 诊断 + 采样 |
| `foreign-target.html` | 受控目标页（跑在独立 profile 的 Chrome 里）。`pointerdown` 时把 `screenX:screenY:pointerType` 写进 `document.title` 作为读数 |
| `e4-result-*.json` | 每次运行原始结果，含逐步日志 |

## 亮点参数

| 参数 | 作用 |
|---|---|
| `-TargetHwnd` / `-TargetTitle` | 选目标（按 hwnd 最可靠，避免中文标题在命令行被转码） |
| `-SetNoActivate` | 跨进程加 `WS_EX_NOACTIVATE`，结束时还原并回读校验 |
| `-Topmost` | `HWND_TOPMOST` + `SWP_NOACTIVATE`，让点击点一定不被遮挡；结束时还原 |
| `-Raise` | `HWND_TOP` + `SWP_NOACTIVATE`（实测对本例的 Chrome 窗口**无效**，保留作对照） |
| `-ReadOnly` | 只打印当前扩展样式 |
| `-ParkProc` / `-NoPark` | 布置初始前台；park 失败会自动用 `AttachThreadInput` 回退 |
| `-KeepStyle` | 不还原样式（默认一定会还原） |

## 读数与诊断

- **标题**：`E4-C<点击次数>-M<mousedown 次数>-L<screenX:screenY:pointerType>`
- **preflight**：注入前算一次「这个坐标此刻会被哪个窗口接收」以及目标在 z 序里的位置。E4 早期几次"点击丢失"全靠它定位到是 **SodaMusic 压在点击点上**。

## 安全边界

只用文档化接口：`GetWindowLongPtr`/`SetWindowLongPtr`、`SetWindowPos`、`CreateSyntheticPointerDevice`/`InjectSyntheticPointerInput`、`SetForegroundWindow`/`SwitchToThisWindow`、`AttachThreadInput`（**仅用于布置前台**，不参与注入）。

**不含**：DLL 注入、全局钩子、`SendInput`、`mouse_event`、光标移动、驱动或注册表修改。

目标窗口的扩展样式**只在单次运行期间被改动，并在结束时还原 + 回读校验**（`mitigation.restored`）。
