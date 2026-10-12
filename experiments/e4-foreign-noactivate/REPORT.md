# E4 跨进程 WS_EX_NOACTIVATE 验证结果

- 实验日期：2026-10-12（紧接 E1/E2/E3）
- 机器：Windows 10 19045
- 脚手架：`E4ForeignNoActivate.ps1`（对**别的进程**的窗口读写扩展样式 + 合成笔点击 + 读数）
- 目标：自己用独立 profile 起的 Chrome（进程外），页面 `foreign-target.html`
- 数据：同目录 `e4-result-*.json`

## 1. 问题

E3 在**自己进程创建**的见证窗口上验证了：

```
合成笔点击 + WS_EX_NOACTIVATE  =>  命中 + 光标零位移 + 前台不变
```

E4 问的是产品上真正要用的那一半：**能不能对别人进程里已经存在的窗口，在运行时加上这个样式、用完再撤掉，并得到同样的效果？**

```
prev = GetWindowLongPtrW(hwnd, GWL_EXSTYLE)              // -20
SetWindowLongPtrW(hwnd, GWL_EXSTYLE, prev | 0x08000000)  // WS_EX_NOACTIVATE
... 合成笔点击 ...
SetWindowLongPtrW(hwnd, GWL_EXSTYLE, prev)               // 还原
```

读数用目标页面自己写的窗口标题（`pointerdown` 时写入 `screenX/Y` 和 `pointerType`），不依赖截图。注入前会先做一次 **preflight**：算出「此刻这个坐标实际会被哪个窗口接收」以及目标在 z 序里的位置。

## 2. 实验协议（迭代后定稿）

顺序很关键，改过一次：

1. 解析目标窗口
2. **先 park**：把前台让给 SpectrAI，并回读校验（`targetWasForeground=false` 才算数）
3. 加 `WS_EX_NOACTIVATE`（跨进程），立刻回读确认
4. 可选 `HWND_TOPMOST` + `SWP_NOACTIVATE`，记录 z 序变化
5. 记录 `fgAfterSetup`——确认上面这些动作**没有**改变前台
6. preflight（谁在接这个坐标）
7. 注入合成笔点击
8. 记录标题 / 光标 / 前台；还原样式与 topmost，并回读校验

> 早先的版本是「先改窗口再 park」，结果 park 一直失败、拿不到合法后台态。另外 park 需要 `AttachThreadInput` 回退才能突破前台锁——**这一步只用于布置初始状态，不参与注入路径**，属于本实验的额外手法，如实记录。

## 3. 结果

### 3.1 样式读写本身

| 项 | 结果 |
|---|---|
| 跨进程读原始样式 | `0x100`（`WS_EX_WINDOWEDGE`），无 `WS_EX_NOACTIVATE` |
| 跨进程加样式后回读 | `0x8000108` → `noActivateAtInject=true`（**注入前一刻样式确实在**） |
| 还原后回读 | `0x100`，与原值一致（`restored=true`） |

→ 跨进程读写并还原别人的窗口扩展样式，**可行且可验证**。

### 3.2 让它不被遮挡

| 手段 | 效果 |
|---|---|
| `HWND_TOP` + `SWP_NOACTIVATE` | **无效**：z 序 7 → 7（SodaMusic 仍在上面接走点击） |
| `HWND_TOPMOST` + `SWP_NOACTIVATE` | **有效**：z 序 7 → 1，`receiver=目标`；结束时已还原 |

### 3.3 点击与干扰（全部为合法后台运行：`park=ok-via-attach`、`targetWasForeground=false`、`conclusive=true`）

| 运行 | 样式 | 点击命中 | 坐标/类型 | 光标 | 前台 |
|---|---|---|---|---|---|
| 对照（topmost，不改样式） | `0x100` | ✅ | `L2800:500:pen` | 0×0 | **被抢**（`distinct=2`，SpectrAI → 目标） |
| 缓解 #1 | `0x8000108`，`atInject=true` | ✅ | `L2800:500:pen` | 0×0 | **被抢**（同上） |
| 缓解 #2 | 同上 | ✅ | `L2800:500:pen` | 0×0 | **被抢**（同上） |

两次缓解运行完全一致。`fgAfterSetup=48892734`（SpectrAI）证明 topmost 没有动前台；前台是被**点击**那一刻改掉的。

### 3.4 反证：同样的手法用在自建窗口上**有效**

为了分清「是 Chrome 自己抢」还是「运行时加样式本来就没用」，用 E3 的见证窗口做了对照：

| 见证窗口 | 前台 |
|---|---|
| 创建时带 `WS_EX_NOACTIVATE` | `stable=true`，`distinct=1` |
| **创建时不带、事后用同一个 `SetWindowLongPtr` 加上**（回读 `ok=True`） | **`stable=true`，`distinct=1`** |

→ 运行时加样式**在普通窗口上是有效的**。所以 E4 的失败不是「事后加不算」，而是目标应用自己的行为。

## 4. 结论

1. **跨进程 `WS_EX_NOACTIVATE` 的机件是通的**：能加、能读回确认、能在注入前一刻确认仍然生效、能原样还原。
2. **合成笔点击照旧命中且光标零位移**（三次 `L2800:500:pen`，`pointerType=pen`），与 E3 一致。
3. **但它挡不住 Chromium/Electron 抢前台。** 样式在注入前确实存在（`noActivateAtInject=true`），点击仍然把 Chrome 窗口激活了；对照组与缓解组表现**完全相同**。
4. **原因是应用自己的行为，不是样式时机。** 同样的事后加样式，用在自己创建的普通窗口上能让前台保持不变（3.4）。所以合理推断是：**Chromium 在收到指针输入时会自行把窗口拉到前台**（这条是推断，没有读 Chromium 源码确认，只做了行为对照）。
5. **对研究方向的直接影响**：E3 里"`WS_EX_NOACTIVATE` 一行消除抢前台"的结论**只对自己创建的窗口成立，不能外推到真实应用**。对真实的 Chromium/Electron 目标，点击路径**必须默认接受一次前台切换**，除非改用不依赖激活的机制（例如 UIA 的 `Invoke`）或从应用侧配合。

## 5. 已知缺陷与局限

- **只测了一个真实应用**（Chrome）。Notepad、Electron（汽水音乐）、Qt（微信）都没测，"是否所有 Chromium/Electron 都这样"没有验证。
- **只测了顶层 `Chrome_WidgetWin_1`**，没有对 render widget 子窗口单独设样式。
- **机制是推断**：只做了行为对照，没有读 Chromium 源码确认它在哪里调用前台提升。
- **`AttachThreadInput` 回退**：park 用到它才能突破前台锁。它只影响布置阶段，不参与注入，但它确实是一次"输入队列挂接"，应当如实计入本实验的非零手法。
- **一次误点**：早期运行里点击点被 SodaMusic 挡住，那一次点击落在了 SodaMusic 窗口上（无可见后果），随后改用 topmost 拿到无遮挡目标。
- `HWND_TOPMOST` 会短暂改变用户桌面的 z 序（约 2 秒），已还原。

## 6. 复现

```bash
cd experiments/e4-foreign-noactivate

# 起目标：独立 profile 的 Chrome，页面自带标题读数
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --user-data-dir=%TEMP%\e4-chrome-profile --no-first-run --window-position=2400,300 --window-size=800,400 \
  "file:///<abs-path>/experiments/e4-foreign-noactivate/foreign-target.html"

# 只看当前样式
powershell -NoProfile -ExecutionPolicy Bypass -File E4ForeignNoActivate.ps1 -TargetTitle 'E4-' -ReadOnly

# 对照组：park -> topmost -> 点击（不改样式）
powershell -NoProfile -ExecutionPolicy Bypass -File E4ForeignNoActivate.ps1 \
  -TargetTitle 'E4-' -Topmost -ParkProc SpectrAI

# 缓解组：park -> 跨进程加 WS_EX_NOACTIVATE -> topmost -> 点击
powershell -NoProfile -ExecutionPolicy Bypass -File E4ForeignNoActivate.ps1 \
  -TargetTitle 'E4-' -SetNoActivate -Topmost -ParkProc SpectrAI

# 反证：自建窗口，样式事后加
cd ../e3-pen-click
powershell -NoProfile -ExecutionPolicy Bypass -File E3PenClick.ps1 -Mode run \
  -X 2400 -Y 200 -W 600 -H 300 -ParkProc SpectrAI -AddStyleLater
```

## 7. 建议的下一步

1. **扩大样本**：对 Notepad（经典 Win32）、汽水音乐（Electron）分别做同样的 A/B，判断"自己抢前台"是 Chromium 家族特性还是更普遍。
2. **寻找不依赖激活的点击路径**：UIA 的 `InvokePattern` 已经在 Claw 里用于标准控件；对 Chromium 可评估 UIA/CDP 的点击通道能否替代合成笔。
3. **与 E2 合起来看**：键盘路径（E2）在后台**不需要**激活就能送达，点击路径却会抢前台。产品上可以据此分工：文字输入走键盘路径，点击优先走 UIA，只有两者都失败时才接受一次前台切换并明确告知用户。
4. **虚拟屏（E5）**：即使样式无效，把窗口放到看不见的屏上仍能保证"用户看不到前台切换"——这提高了虚拟屏的相对价值。
