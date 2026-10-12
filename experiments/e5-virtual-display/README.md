# E5 虚拟显示器实验

目标：装一个 IddCx 虚拟显示器，把目标窗口移到"用户看不见、且不会被遮挡"的屏上，再跑 E3/E4 的合成笔点击测试。

## 状态：**未完成 — 当前会话没有管理员权限**

安装显示驱动必须提升权限。本轮只完成了**只读侦察**、**驱动包的下载与签名核验**，以及把**官方控制端下到本机下载目录**（等你有空双击安装）。没有任何安装动作。

**下一步（你来做，约 2 分钟）**：解压 `C:\Users\魏斌\Downloads\VDD.Control.25.7.23.zip` → 运行里面的 `VDD Control.exe` → 它会自己弹 UAC。装完告诉我，我接着跑虚拟屏上的笔点击测试。

完整事实、已校验的驱动信息、安装步骤与回滚方式都在 [`REPORT.md`](REPORT.md)。

## 文件

| 文件 | 作用 |
|---|---|
| `Recon.ps1` | 只读侦察：管理员权限、OS、显示类设备、显示器设备、虚拟显示驱动归属、bcdedit 测试签名状态 |
| `REPORT.md` | 结论、已查清的事实、阻塞点、三条可行路径、回滚命令 |

## 快速复现

```powershell
# 只读侦察
.\Recon.ps1

# 手动看显示器数量（应为 2）
powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name,Status"
```

## 已核验的驱动（尚未安装）

| 项 | 值 |
|---|---|
| release | `VirtualDisplayDriver-x86.Driver.Only.zip`（132,118 字节） |
| 来源 | `https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/` |
| sha256 | `e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a` |
| 签名 | `MttVDD.dll` / `mttvdd.cat` 均为 `Valid`，签发者 `CN=SignPath Foundation` |
| 类型 | UMDF / IddCx，`Class=Display`，硬件 ID `Root\MttVDD` |
| 是否需要测试签名 | **不需要**（标准签名链） |

> "x86" 是该项目的命名习惯，指 x86-64（与 ARM64 并列），不是 32 位。
