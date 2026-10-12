# E1 焦点伪造 / 后台投递实验脚手架

对应研究方案里的 **E1**：只用消息投递（激活伪造 + 键盘消息），能否把文字送进**非前台窗口**的输入控件，同时不动光标、不改前台窗口。

- 实验结论与数据解读：见 [`REPORT.md`](REPORT.md)
- 起因：`UFO² 画中画隔离桌面可行性` 会话提出的「第二指针 / 第二屏 / 第二焦点 / 输入仲裁」框架

## 文件

| 文件 | 作用 |
|---|---|
| `E1FocusSpoof.ps1` | 全部逻辑。PowerShell 外壳 + 内联 C# P/Invoke；**故意保持 100% ASCII**，因为 PS 5.1 会用 ANSI 代码页解析无 BOM 的 .ps1 |
| `chromium-target.html` | Chromium 受控目标页：一个 `autofocus` 的 input |
| `summarize.js` | 把 `e1-result-*.json` 汇总成一张表（`node summarize.js`） |
| `e1-result-*.json` | 每次运行的原始结果，含逐次采样明细 |
| `windows.json` | 最近一次 `-Mode list` 的窗口/子控件清单 |

## 安全边界

脚手架**只**使用：`EnumWindows`/`EnumChildWindows`、`SendMessage`/`PostMessage`、`GetCursorPos`、`GetForegroundWindow`、`PrintWindow`、`SwitchToThisWindow`/`SetForegroundWindow`。

明确**不含**：DLL 注入、全局钩子、`AttachThreadInput`、`SendInput`/`mouse_event`、光标移动、注册表/系统设置修改。运行期间只会临时抬高一次系统定时器精度（`timeBeginPeriod(1)`，结束即恢复）。

## 快速用法

```powershell
# 列窗口与子控件（结果写 windows.json，UTF-8）
.\E1FocusSpoof.ps1 -Mode list -TargetProc 'notepad|chrome' -ChildClass '.*'

# 一次实验
.\E1FocusSpoof.ps1 -Mode run -TargetProc notepad -ChildClass '^Edit$' `
  -CharMode char -ParkProc SpectrAI -Snapshot
```

常用参数：`-TargetHwnd` / `-InjectHwnd`（按精确 hwnd 定位，避免 CJK 标题在命令行被转码）、`-InjectTo self|child`、`-ParkProc/-ParkClass/-ParkTitle`、`-ParkSelf`、`-NoSpoof`、`-Snapshot`、`-Text`、`-PreMs/-PerCharMs/-SettleMs`。

## 结论速览

| 目标 | 后台投递 | 光标 | 前台窗口 |
|---|---|---|---|
| Win32 标准控件（记事本 Edit，`WM_CHAR`） | **成功**，文本逐字符一致 | 0 位移 | 全程不变 |
| Chromium / Chrome | **失败**（前台可投，切到后台即 0 变更像素） | 0 位移 | 全程不变 |
| Electron（汽水音乐） | 0 变更像素，但读数通道不足，判为「不构成证据」 | 0 位移 | 全程不变 |

即：标准控件已可纯后台；Chromium 的缺口在**线程级激活状态**，需要 E2（`AttachThreadInput` + `SetKeyboardState`）继续验证。
