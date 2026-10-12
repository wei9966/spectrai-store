# 虚拟显示器安装引导（Windows）

面向需要「Agent 操作真实应用、用户不被打断」的场景。**装之前先读完第 1 节**。

## 1. 为什么需要它

E6/E7 系列实测（结论已被 `tests/windows-invoke-foreground-side-effect.test.mjs` 固化为回归测试）表明：

| 通道 | 后台发起 | 光标 | 抢前台 |
|---|---|---|---|
| 键盘消息（WM_CHAR / Tab 移焦） | ✅ | 0 | **不抢** |
| UIA 动作（invoke / toggle / setValue / focus） | ✅ | 0 | **抢** |
| 合成笔（`InjectSyntheticPointerInput`） | ✅ | 0 | **抢** |
| HID（`SendInput`） | ✅ | **移动** | **抢** |

也就是说：**「点击/激活控件」必然抢一次前台，纯软件层面没有已知的绕法**（`WS_EX_NOACTIVATE` 对真实应用无效，UIA 动作本身就是激活）。

→ **虚拟屏是唯一能让这一次"抢前台"不被用户察觉的办法**：把目标窗口放到一块**没有物理输出**的屏上，抢的就成了那块看不见的屏。

附带收益：**彻底解决遮挡**。虚拟屏上没有用户的窗口，点击不会被截走（实测副屏上 `preflight.receiver` 是别的窗口导致点击丢失，虚拟屏上 `isTarget=true` 必中）。

## 2. 两条可选路线

| | **IddCx 虚拟显示器** | Windows 虚拟桌面 |
|---|---|---|
| 安装成本 | 需装第三方签名驱动（提权 + 用户确认发布者） | 零安装（系统自带 COM API） |
| 用户可见性 | **永远看不到**（无物理输出） | 切换桌面就能看到 |
| 输入是否可达 | **已实测可用**（UIA 与合成笔均正常） | **未验证**（输入按当前桌面的前台派发，存疑） |
| 截图 | 正常 | 受限 |
| 结论 | **✅ 推荐** | ⚠️ 待验证的轻量替代 |

> 注：`CursorTouch/Windows-MCP` 用 Windows 虚拟桌面 `IVirtualDesktopManager` 做**只读感知**（它的 `vdm` 模块只导出 `get_all_desktops` / `get_current_desktop` / `is_window_on_current_desktop`），并没有用它做隔离。所以那不是现成的可行参照。

## 3. 安装步骤（VirtualDisplayDriver）

以 `VirtualDisplayDriver` release `25.7.23` 为例（包：`VDD.Control.25.7.23.zip`）。

1. 下载官方控制端 zip。
2. **以管理员身份**运行控制端；若控制端不可用，走下面第 4 节的手动方式。
3. 安装过程中会弹 **「Windows 安全中心」**对话框（第三方签名驱动必须由用户确认发布者）→ 点 **「安装」**。
4. **不需要重启**（`devcon` 不加 `-r`）。
5. 验证：显示器数量 +1（见第 5 节）。

### 这一步会踩的坑（实测）

- 安装会被那个安全对话框**卡住**（`pnputil` 一直阻塞）。
- 该对话框由**提升的 `rundll32`** 拥有，普通权限进程**既不能给它发消息**（UIPI 直接拒绝 `SendMessage`/`BM_CLICK`），**合成笔也点不动它**（注入返回 `ok`、坐标精确，对话框毫无反应）——**必须用提升权限的进程**去点，或者让人手动点。
- 期间可能弹**两次** UAC（一次装驱动、一次处理对话框）。

## 4. 手动安装方式（控制端不可用时）

```powershell
# 需要管理员 PowerShell
pnputil /add-driver "<path>\MttVDD.inf" /install
devcon install "<path>\MttVDD.inf" "Root\MttVDD"
```

`devcon.exe` 随官方控制端包提供（`Dependencies/devcon.exe`）。`Root\MttVDD` 是它声明的硬件 ID。

## 5. 验证

用 Claw 自己的工具即可（不用另外装东西）：

```
list_monitors
```

输出里应当多出一块 **`windowCount: 0` 的非主屏** —— 那就是虚拟屏。示例（本机实测）：

```
[0] \\.\DISPLAY1   bounds=0,0 1536x864    primary=True
[1] \\.\DISPLAY2   bounds=1920,0 1920x1080 primary=False
[2] \\.\DISPLAY35  bounds=3840,0 800x600   primary=False   <- 虚拟屏
```

## 6. 装好之后怎么用（Claw）

```
1. list_monitors            -> 找到 windowCount=0 的非主屏
2. move_window_to_monitor   -> 把目标窗口搬到那块屏（SWP_NOACTIVATE，不会抢前台）
3. 正常驱动（UIA / 合成笔）  -> 抢前台发生在用户看不见的屏上
```

## 7. 回滚

```powershell
# 需要管理员
pnputil /enum-devices /class Display        # 找到那块屏的 InstanceId
pnputil /remove-device "ROOT\DISPLAY\000N"
pnputil /delete-driver oemNN.inf /uninstall
```

`oemNN.inf` 是安装时驱动仓库里的发布名（安装日志会打印）。

## 8. 风险与注意事项

- **这是系统级改动**：新增一块显示设备 + 驱动仓库多一个 `oemNN.inf`。必须让用户明确同意后再装。
- 装好后**桌面会向右扩展**：鼠标能滑进一块看不见的区域，个别程序可能把窗口开在那里。分辨率默认 **800×600**（可在驱动包的 `vdd_settings.xml` 里配置）。
- 不想要了就按第 7 节卸载；卸载后 Claw 的 `list_monitors` 会少一块屏，功能自动回落。
