# E5 虚拟显示器实验

目标：装一个 IddCx 虚拟显示器，把目标窗口移到"用户看不见、且不会被遮挡"的屏上，再跑 E3/E4 的合成笔点击测试。

## 状态：**已完成 ✅**

虚拟显示器已装好并验证：

```
screens  : 2 -> 3
新增      : \\.\DISPLAY35  {X=3840, Y=0, 800x600}   无物理输出覆盖
设备      : Virtual Display Driver / ROOT\DISPLAY\0003 / OK
驱动发布名 : oem22.inf
```

**三条结论**：① 虚拟屏彻底解决了"目标被别的窗口遮挡"这个硬限制（副屏上 preflight 指向 SodaMusic、点击丢失；虚拟屏上指向目标本身、点击必中）；② 自建窗口 + 创建时带 `WS_EX_NOACTIVATE` 可以做到命中精确、光标零位移、前台全程不变；③ **Chromium 抢前台的问题依然存在**，但窗口在看不见的屏上，不会遮挡用户。

**顺带发现一条重要边界**：合成笔输入**受 UIPI 约束** —— 对提升权限的窗口无效（安装驱动时那个"Windows 安全中心"对话框就是提升的，合成笔点了没反应）。这一点 E3 没暴露出来，因为当时的目标都是同完整性级别的。

完整实录与数据见 [`REPORT.md`](REPORT.md)。

## 文件

| 文件 | 作用 |
|---|---|
| `Recon.ps1` | 只读侦察：管理员权限、OS、显示类设备、显示器、虚拟显示驱动归属、bcdedit 测试签名状态 |
| `Install-Vdd.ps1` | 提升权限安装（`pnputil /add-driver` + `devcon install`），全程写日志，打印回滚命令 |
| `ClickInstallDialog.ps1` | 提升权限处理"Windows 安全中心"对话框（按**按钮文本**匹配，不是靠坐标猜） |
| `SecureDialog.ps1` | 对话框结构查看 + 合成笔点击（用于证明 UIPI 会拦合成输入） |
| `install-log.txt` | 本次安装的原始日志（含 before/after 快照） |
| `click-log.txt` | 处理安全对话框的原始日志（含读到的按钮文本） |

## 回滚

```powershell
# 需要管理员
pnputil /remove-device "ROOT\DISPLAY\0003"
pnputil /delete-driver oem22.inf /uninstall
```

## 安装材料位置

- 官方控制端：`C:\Users\魏斌\Downloads\VDD.Control.25.7.23.zip`
- 已解压的驱动 + `devcon.exe`：`F:\e5vdd\`（不在 git 仓库里）

> "x86" 是该项目的命名习惯，指 x86-64（与 ARM64 并列），不是 32 位。
