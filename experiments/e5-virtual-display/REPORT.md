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

## 4. 三条可行路径（需要你选一条）

### A. 你把 UAC 点掉，我来装（推荐）
我会写一个**只做这几件事**的提升权限脚本，然后触发 UAC：

1. 校验当前进程确实已提升，否则立刻退出并说明；
2. 把驱动拷到固定目录（便于回滚）；
3. `pnputil /add-driver <dir>\MttVDD.inf /install`；
4. 创建 `Root\MttVDD` 设备节点（这一步的具体命令我会先用 `pnputil /enum-devices` 验证结果，失败就原样报告，不反复试）；
5. 打印**新的显示器列表**，确认多出来一块；
6. 脚本本身**不做任何删除操作**，回滚命令写在脚本注释里。

装完我会立刻跑 E3/E4 的笔点击测试，把窗口放到那块看不见的屏上，验证"无遮挡 + 后台命中 + 前台不变"。

### B. 你自己跑（我只给命令）
我把上面那一段写成 `Install-Vdd.ps1` 放进仓库，你开一个**管理员 PowerShell** 执行一次即可。我这边不触发任何 UAC。

### C. 不装，用现有副屏
E3 已经用真实副屏测过跨屏路由。差别是：真实屏**你看得见**，而且屏上的窗口仍会被遮挡（E4 就是被 SodaMusic 挡住了）。虚拟屏的核心价值正是这两点，所以这个选项等于放弃 E5 的验证。

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
