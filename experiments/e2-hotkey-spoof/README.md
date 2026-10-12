# E2 后台热键投递实验脚手架

对应研究方案里的 **E2**：用 `AttachThreadInput` + `SetKeyboardState` 写入修饰键状态，验证**非前台** Chromium 窗口能否收到热键（Ctrl+A）。

- 结论与全部数据解读：见 [`REPORT.md`](REPORT.md)
- 本实验同时**推翻了 E1 对 Chromium 的负结论**（E1 的位图读数在非活动窗口上是假阴性）

## 文件

| 文件 | 作用 |
|---|---|
| `E2HotkeySpoof.ps1` | 全部逻辑。PowerShell 外壳 + 内联 C# USER32。**故意保持 100% ASCII**（PS 5.1 用 ANSI 代码页解析无 BOM 的 .ps1） |
| `chromium-target.html` | 受控目标页。**带 `autofocus`**：窗口标题即读数通道，格式 `E2-C<ctrlA次数>-K<keydown次数>-I<输入框长度>` |
| `chromium-target-nofocus.html` | 同一页面去掉 `autofocus`，用来验证「必须有聚焦元素」这个门槛 |
| `e2-result-*.json` / `e2-probe-*.json` | 单次运行与批量扫描的原始结果 |
| `windows.json` | 最近一次 `-Mode list` 的窗口/子控件清单 |

## 为什么要用窗口标题做读数

Chromium **不重绘非活动窗口的内容**。E1 用 `PrintWindow` 位图差异判定，导致后台运行被系统性读成「没送达」——这是 E1 唯一的、也是最要命的错误来源。

E2 改成：目标页面把事件计数写进 `document.title`，浏览器进程会更新窗口标题（与焦点无关），再用 `GetWindowText` 跨进程读回。零依赖、零注入，且后台一样有效。

```
E2-C3-K6-I48
   C = 页面见到的 Ctrl+A 次数      （热键是否带修饰键送达）
   K = 页面见到的 keydown 次数      （按键是否送达）
   I = textarea 当前值长度          （文字是否真的被插入）
```

## 安全边界

只使用文档化 USER32 接口：`AttachThreadInput`、`SetKeyboardState` / `GetKeyboardState`、`PostMessage`、`SendMessage`、`GetForegroundWindow`、`GetCursorPos`、`SwitchToThisWindow` / `SetForegroundWindow`、`PrintWindow`。

明确**不含**：DLL 注入、全局钩子、`SendInput`/`mouse_event`、光标移动、注册表/系统设置修改。

每次运行都在 `finally` 里还原原始键盘状态并解挂输入队列，并输出 `selfCheck.polluted` 供外部核对（全部运行为 `false`）。

## 快速用法

```powershell
# 列窗口与子控件
.\E2HotkeySpoof.ps1 -Mode list -TargetTitle 'E2-' -ChildClass '.*'

# 单次：后台 + 修饰键伪造（-NoSpoof 可关掉伪造做对照）
.\E2HotkeySpoof.ps1 -Mode run -TargetHwnd <hwnd> -InjectHwnd <widget> -ParkProc SpectrAI

# 候选注入点扫描：顶层 + 每个 RenderWidget × {无伪造, 有伪造}
.\E2HotkeySpoof.ps1 -Mode probe -TargetTitle 'E2-' -ChildClass '^Chrome_RenderWidgetHostHWND$' -ParkProc SpectrAI
```

参数：`-Key A|C|V`、`-NoSpoof`、`-AlsoCtrlKey`、`-WithActivationMsgs`、`-ParkSelf`、`-ParkProc/-ParkClass/-ParkTitle`、`-NoPark`、`-PreMs/-HoldMs/-SettleMs`。

> 注意：`-Mode probe` 会跑 2×候选数 次运行，容易触及命令超时；批量比较时拆成多次 `-Mode run` 更稳。

## 结论速览

| 场景 | 后台结果 |
|---|---|
| 页面有聚焦元素，只投递消息 | 按键送达（`K` 增长） |
| 页面有聚焦元素，+ 修饰键伪造 | **Ctrl+A 生效**（`C` 增长） |
| 页面有聚焦元素，E1 原始方法（`WM_KEYDOWN`+`WM_CHAR`） | **文字真被插入**（`I` +30） |
| 页面无聚焦元素，同样条件 | **不送达**（`K` 不变，两次一致） |
| 全部场景 | 光标 0 位移、前台窗口不变、修饰键无污染 |

激活消息（`WM_NCACTIVATE`/`WM_ACTIVATE`/`WM_SETFOCUS`）**不是必需的**；修饰键伪造单独就足以让 Ctrl+A 在后台生效。
