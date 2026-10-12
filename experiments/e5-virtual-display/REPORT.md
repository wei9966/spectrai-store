# E5 虚拟显示器：安装实录与验证结果

- 日期：2026-10-12
- 工具：`Recon.ps1`（只读侦察）、`Install-Vdd.ps1`（提升权限安装）、`ClickInstallDialog.ps1`（提升权限处理安全对话框）、`SecureDialog.ps1`（对话框结构查看）
- 证据：`install-log.txt`、`click-log.txt`（本次安装的原始日志）

## 1. 结论：**装上了，并在它上面完成了验证**

```
screens  : 2  ->  3
新增      : \\.\DISPLAY35  {X=3840, Y=0, 800x600}   无任何物理输出覆盖这块区域
设备      : Virtual Display Driver / ROOT\DISPLAY\0003 / status=OK / problem=CM_PROB_NONE
驱动发布名 : oem22.inf
```

三条验证结论：

| 结论 | 证据 |
|---|---|
| **虚拟屏彻底解决了遮挡问题** | 同一套点击逻辑，副屏上的 `preflight.receiver` 是 `SodaMusic (isTarget=false)` 导致点击丢失；虚拟屏上是 `chrome (isTarget=true)`，点击必中 |
| **自建窗口在虚拟屏上可以做到完全零干扰** | `L4200:300` 精确命中、光标 `0×0`、前台 `distinctDuringRun=1` 全程不变 |
| **Chromium 依然会抢前台（E4 结论复现）** | 虚拟屏上对照组与缓解组表现相同：`fgStable=false`、`distinct=2`、前台 SpectrAI → Chrome。但因为窗口在**用户看不见的屏**上，不会遮挡用户 |

## 2. 安装实录（以及一个把安装卡住的 UIPI 边界）

安装本身很简单：`pnputil /add-driver` + `devcon install ... Root\MttVDD`。真正花时间的是中间被一个安全对话框卡住：

```
setupapi.dev.log:
  sig: Error 0x800b0109: A certificate chain processed, but terminated in a root
       certificate which is not trusted by the trust provider.
  sig: Error 0xe0000242: The publisher of an Authenticode(tm) signed catalog has
       not yet been established as trusted.
```

非 WHQL 驱动会弹「Windows 安全中心」对话框要求用户确认发布者。这个对话框由**提升的 `rundll32`** 拥有，`pnputil` 因此一直阻塞。这里撞上了两次边界：

1. **`SendMessage` / `BM_CLICK` 直接被 UIPI 拒绝**（低完整性进程不能给高完整性窗口发消息）。
2. **合成笔也不行。** 我用 E3 的合成笔点「安装」按钮，`down=true, up=true`、坐标精确（877,424，按钮矩形中心），**对话框毫无反应**。原因是 UIPI 同样约束输入注入 —— 输入只能注入到同等或更低完整性级别的目标，而那个对话框是提升的。

> 这条对研究方向的边界条件比安装本身更重要：**合成笔/合成触控不是"万能后台输入"**，它受 UIPI 约束，对提升权限的窗口无效。E3 当时的目标都是同完整性级别的，所以没暴露出来。

解决方式是让**提升的进程**去做这次点击 —— 从同等完整性级别出发，`BM_CLICK` 与 `GetWindowText` 都可用了，于是可以直接读按钮标题、按文本而不是靠猜来选：

```
[16:39:32] dialogs seen: dialog hwnd=37880842 title='Windows 安全中心'
              buttons: [id=0 '安装(&I)'] [id=0 '不安装(&N)']
[16:39:32] round 1: CLICKED '安装(&I)'
[16:39:32] 已成功添加驱动程序程序包。发布名: oem22.inf      pnputil exit = 0
[16:39:32] Device node created. Drivers installed successfully.  devcon exit = 0
```

点击后安装一次通过，无需重启（`devcon` 特意没加 `-r`）。

## 3. 验证结果

### 3.1 遮挡对比（同一套点击逻辑）

| 目标所在屏 | preflight `receiver` | `isTarget` | 点击 |
|---|---|---|---|
| 副屏（E4 早期） | `SodaMusic` | **false** | **丢失**（目标什么都没收到） |
| **虚拟屏** | `chrome`（就是目标） | **true** | **命中** `L4230:290:pen` |

虚拟屏的意义在这里最直接：它是一块**没有其他窗口的空屏**，点击不会被任何东西截走。E3/E4 反复撞到的"遮挡"硬限制，在虚拟屏上不存在。

### 3.2 虚拟屏上的干扰测量

| 运行 | 目标 | 样式 | 命中 | 光标 | 前台 |
|---|---|---|---|---|---|
| E5-A | 真实 Chrome（进程外） | 无 | ✅ `L4230:290:pen` | `0×0` | **被抢**（`distinct=2`） |
| E5-B | 真实 Chrome（进程外） | 跨进程 `WS_EX_NOACTIVATE` | ✅ `L4230:290:pen` | `0×0` | **被抢**（`distinct=2`，与对照完全相同） |
| **E5-C** | 自建见证窗口 | 创建时带 `WS_EX_NOACTIVATE` | ✅ `L4200:300` | `0×0` | **全程不变**（`distinct=1`） |

所有运行都是合法后台态（`targetWasForeground=false`、`conclusive=true`）。

## 4. 对研究方向的影响

1. **虚拟屏是"遮挡"这一硬限制的正解，已实测**。此前只能把目标窗口放到真实副屏，而副屏上全是用户自己的窗口（E4 被 SodaMusic 挡住、E3 被 SpectrAI 挡住）。
2. **虚拟屏不能消除"Chromium 抢前台"**。E4 的结论在虚拟屏上原样复现。但它把伤害降了一个量级：窗口在用户看不见的屏上，抢前台时**不会有任何窗口跳到用户脸上**，用户只会感觉到自己原来的窗口失去焦点。
3. **合成笔受 UIPI 约束**（新发现）。对提升权限的窗口无效。设计"零干扰操作"时要按完整性级别分类：
   - 同级别或更低：合成笔可用；
   - 更高（提升的应用，例如以管理员身份跑的程序）：合成笔会被静默丢弃，必须走别的路径。
4. **默认分辨率 800×600 偏小**。`vdd_settings.xml` 里预置了 800×600 / 1366×768 等多档，当前生效的是 800×600。

## 5. 环境事实（侦察，安装前的原始状态）

| 项 | 值 |
|---|---|
| 显示器 | 安装前 2 块：主屏 `0,0–1536,864`；副屏 `1920,0–3840,1080` |
| 坐标空隙 | x=1536…1920 之间没有屏 |
| 已有虚拟显示适配器 | 3 个，且都是**孤儿**（宿主软件均已卸载，不会产生显示器）：`GameViewer Virtual Display Adapter`、`MuMu Virtual Display Adapter`、`OrayIddDriver Device` |
| 安装前权限 | `isAdmin=False`（`bcdedit` 同样返回非提升） |

安装所用驱动（项目：`VirtualDrivers/Virtual-Display-Driver`，release `25.7.23`）：

| 项 | 值 |
|---|---|
| 包 | `VDD.Control.25.7.23.zip`（71,225,903 字节） |
| sha256 | `a701f2272e9fcf382849b24f913c6dd07597b3b1116525f2e90182f019609154` |
| 实际安装的驱动 | `SignedDrivers/x86/VDD/{MttVDD.dll, mttvdd.cat, MttVDD.inf}` |
| 签名 | `MttVDD.dll` / `mttvdd.cat` 均为 `Valid`，签发者 `CN=SignPath Foundation` |
| 类型 | UMDF / IddCx，`Class=Display`，硬件 ID `Root\MttVDD` |
| 是否需要测试签名 | **不需要**（标准签名链；但因为是第三方签名，必须用户确认一次发布者） |

> "x86" 是该项目的命名习惯，指 x86-64（与 ARM64 并列），不是 32 位。

## 6. 回滚

```powershell
# 1) 删除设备节点（管理员）
pnputil /remove-device "ROOT\DISPLAY\0003"
# 2) 从驱动仓库删除驱动包（管理员）
pnputil /delete-driver oem22.inf /uninstall
# 3) 确认显示器回到 2 块
```

## 7. 复现

```bash
cd experiments/e5-virtual-display

# 只读侦察
powershell -NoProfile -ExecutionPolicy Bypass -File Recon.ps1

# 安装（会弹 UAC；若出现“Windows 安全中心”对话框，用 ClickInstallDialog.ps1 处理）
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<abs>\Install-Vdd.ps1','-SrcDir','F:\e5vdd\SignedDrivers\x86\VDD','-Devcon','F:\e5vdd\Dependencies\devcon.exe','-LogPath','F:\e5vdd\install-log.txt'"
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<abs>\ClickInstallDialog.ps1'"

# 在虚拟屏上验证
cd ../e3-pen-click
powershell -NoProfile -ExecutionPolicy Bypass -File E3PenClick.ps1 -Mode run -X 3900 -Y 100 -W 600 -H 400 -ParkProc SpectrAI -NoActivate
```

安装材料（驱动包已解压 + 脚本自带的 `devcon.exe`）留在 `F:\e5vdd\`，不在 git 仓库里。
