# E5 虚拟显示器：环境侦察结果与阻塞点

- 日期：2026-10-12
- 探针：`Recon.ps1`（只读；除 `net session` 外不改动任何东西）
- 目标：装一个 IddCx 虚拟显示器，把目标窗口放到"用户看不见、也不会被遮挡"的屏上，再跑 E3/E4 的笔点击测试

## 1. 结论先行：**当前会话没有管理员权限，装不了**

```
isAdmin : False
bcdedit : exit=1（非提升权限）
```

安装显示驱动（`pnputil /add-driver ... /install`，以及创建 root 设备节点）**必须提升权限**。因此本轮**没有安装任何驱动**，也就**没有得到虚拟屏的实测结果**。下面是我已经查清、可以直接拿来执行的全部事实与步骤。

## 2. 已查清的事实

### 2.1 本机显示拓扑

| 项 | 值 |
|---|---|
| 显示器 | 2 块：主屏 `0,0–1536,864`（工作区到 824）；副屏 `1920,0–3840,1080` |
| 坐标空隙 | x=1536…1920 之间没有屏；鼠标长期停在 (1845,725) 的空隙里 |
| 显示适配器 | NVIDIA RTX 5060 Ti + **3 个虚拟显示适配器** |

### 2.2 已有的三个虚拟显示适配器（都是孤儿）

| 设备 | 驱动版本 | 状态 | 配套软件 |
|---|---|---|---|
| `GameViewer Virtual Display Adapter` (`ROOT\DISPLAY\0000`) | 15.6.5.199 | OK / `CM_PROB_NONE` | GameViewer 服务**未安装** |
| `MuMu Virtual Display Adapter` (`ROOT\DISPLAY\0001`) | 20.36.41.498 | OK / `CM_PROB_NONE` | MuMu 服务**未安装** |
| `OrayIddDriver Device` (`ROOT\DISPLAY\0002`) | 17.50.19.949 | OK / `CM_PROB_NONE` | Oray/向日葵 服务**未安装** |

驱动本体在，"用户态组件"（IddCx 里负责请求拓扑、真正创建监视器的那一半）随其宿主软件一起被卸载了，所以它们**当前都不会产生显示器**（实测只有 2 个 monitor）。想复用它们需要装回各自的宿主软件，或提升权限去操作设备节点——两条路都比直接装一个干净的 IddCx 驱动更麻烦。

### 2.3 选定的驱动（已下载并校验）

- 项目：`itsmikethetech/Virtual-Display-Driver`（GitHub 现重定向到 `VirtualDrivers/Virtual-Display-Driver`）
- 最新 release：`25.7.23`（发布 2025-07-23）
- 取的文件：`VirtualDisplayDriver-x86.Driver.Only.zip`，**132,118 字节**
- `sha256 = e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a`
- （同 release 的 `VDD.Control.25.7.23.zip` 是 71 MB 的 GUI 控制端，本次没下。）

包内容与签名核验：

| 文件 | 大小 | 签名 |
|---|---|---|
| `MttVDD.dll` | 251,640 | `Valid`，签发者 `CN=SignPath Foundation` |
| `mttvdd.cat` | 13,017 | `Valid`，签发者 `CN=SignPath Foundation` |
| `MttVDD.inf` | 4,132 | — |
| `vdd_settings.xml` | 2,779 | — |

INF 关键内容：

```
Class     = Display          ClassGUID = {4D36E968-...}
DriverVer = 12/24/2024,11.30.4.434
CatalogFile = MttVDD.cat
[Standard.NTamd64]
  %DeviceName% = MyDevice_Install, Root\MttVDD
  %DeviceName% = MyDevice_Install, MttVDD
[MyDevice_HardwareDeviceSettings]
  HKR,, "UpperFilters", %REG_MULTI_SZ%, "IndirectKmd"
  HKR, "WUDF", "DeviceGroupId", %REG_SZ%, "MttVDDGroup"
UmdfService = MttVDD,MttVDD_Install
ServiceBinary = %12%\UMDF\MttVDD.dll
```

要点：这是一个 **UMDF / IddCx 驱动**，"x86" 在这个项目的命名里指 x86-64（与 ARM64 并列），**不是** 32 位。签名是标准代码签名证书链（不是测试签名），所以**不需要开 `testsigning`、不需要重启进测试模式**。

### 2.4 为什么不能只靠一条 `pnputil` 命令

它是 **root 枚举（`Root\MttVDD`）的 UMDF 设备**：`pnputil /add-driver MttVDD.inf /install` 只能把驱动装进驱动仓库，**不会自动创建那个 root 设备节点**，因此不会产生显示器。真正的创建需要一个能造 root 设备的途径，常见三种：

1. 项目自带的控制端（`VDD.Control`，71 MB）——最省事，但要多下一个大包；
2. WDK 的 `devcon install MttVDD.inf Root\MttVDD`（本机没装 WDK）；
3. 设备管理器里的"添加过时硬件"手动选 INF（纯 GUI，需要人点）。

所以这一步**不只是"要管理员"，还需要人在场**（无论是点 UAC 还是点设备管理器）。

## 3. 我没有做的（以及为什么）

- **没有安装驱动**：需要提升权限，且这是对用户日常机器的系统级改动（内核可见的显示设备 + 驱动程序仓库条目），不适合在没有明确授权路径的情况下硬闯。
- **没有启用已有的三个孤儿适配器**：同样需要提升权限；且它们的用户态组件缺失，启用设备节点大概率也产生不了显示器。
- **没有下 71 MB 的控制端**：在"能不能装"还没确定之前，先不往用户磁盘上放东西。

## 4. 官方支持的安装方式（控制端已下到本机）

查了项目的 README，**官方只支持用自带的 `VDD Control` 控制端安装**（driver-only 包不是受支持的安装路径）。所以我把控制端下到了你的下载目录：

| 项 | 值 |
|---|---|
| 文件 | `C:\Users\魏斌\Downloads\VDD.Control.25.7.23.zip`（71,225,903 字节） |
| sha256 | `a701f2272e9fcf382849b24f913c6dd07597b3b1116525f2e90182f019609154` |
| 来源 | `https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VDD.Control.25.7.23.zip` |

解压后的关键内容（这就是为什么它比 driver-only 包可靠）：

```
VDD Control.exe                        (171 MB，带 UAC 清单的控制端)
Dependencies/devcon.exe                <- 创建 Root\MttVDD 设备节点用它
SignedDrivers/x86/VDD/{MttVDD.dll, mttvdd.cat, MttVDD.inf, vdd_settings.xml}
SignedDrivers/ARM64/VDD/{...}
SignedDrivers/x86/VAD/{VirtualAudioDriver.sys, .inf, .cat}   <- 配套虚拟音频驱动
```

注意两点：

1. `Dependencies/devcon.exe` 的存在**印证**了第 2.4 节的判断：`pnputil` 装不了 root 设备节点，必须用能造 root 设备的工具。
2. `SignedDrivers/x86/` 里的 `MttVDD.*` 和我单独下的 driver-only 包**是同一份文件**（`mttvdd.cat` 13,017 字节、日期 2024-12-25），所以这个项目里的 "x86" 就是指 x86-64。

### 你要做的（大约 2 分钟）

```powershell
# 1) 解压
Expand-Archive -Path "$env:USERPROFILE\Downloads\VDD.Control.25.7.23.zip" -DestinationPath "$env:USERPROFILE\Downloads\VDD-Control"

# 2) 双击运行 VDD Control.exe（它会自己弹 UAC），按界面里的 Install / Add display 操作
```

装完后告诉我，我会立刻接着做 E5 的第二步：把目标窗口放到那块看不见的屏上，跑 E3/E4 的笔点击测试，验证「无遮挡 + 后台命中 + 光标零位移 + 前台不变」。

### 备选：不用控制端

如果你想手动来，`Dependencies/devcon.exe` 就是官方自带的那一个：

```powershell
# 管理员 PowerShell，在解压目录下
.\Dependencies\devcon.exe install .\SignedDrivers\x86\VDD\MttVDD.inf Root\MttVDD
```

我不在正文里替你跑这条：它需要管理员，而且我还没在这台机器上验证过 `devcon` 的实际输出，不适合在没有你确认的情况下动你的驱动仓库。

### 我为什么不自己硬装

- 当前会话 `isAdmin=False`（`bcdedit` 也印证），`pnputil`/`devcon` 都会失败；
- 触发 UAC 需要你本人在场点确认，你没在的这 10 分钟里弹窗只会超时；
- 装显示驱动是系统级改动（会进驱动仓库、多一个显示设备），我不想在没有人盯着的情况下自作主张。

## 5. 回滚方式（三条路通用）

```powershell
# 1) 删除设备节点
pnputil /remove-device "<InstanceId，从 pnputil /enum-devices /class Display 里取>"
# 2) 从驱动仓库删除驱动（oemNN.inf 编号同上一步输出）
pnputil /delete-driver oemNN.inf /uninstall
# 3) 确认显示器数量回到 2
```

## 6. 复现侦察

```bash
cd experiments/e5-virtual-display
powershell -NoProfile -ExecutionPolicy Bypass -File Recon.ps1
```
