# SpectrAI Claw 探活复盘 → 修复优先级

> 依据：探活真实故障（通道断、选中≠激活、焦点/遮挡）+ 产品定位：**通用桌面插件**，不为单一 App 特化。
> 目标：先能稳跑，再**尽快完成点击/激活/输入**；App 差异靠通用语义，不靠微信白名单。

## 一句话

探活暴露的是通道与「动作是否真生效」；后续加速必须是 **UIA 语义优先 + 短路径 fallback**，不是给微信写特例。

## P0 — 已落地（本周）

| 项 | Commit | 状态 |
|---|---|---|
| P0-1 PersistentShell 自愈 / 串行 / ping | `6000693` | done |
| P0-2 选中≠打开 + HID 降级 | `80e0595` | done（**含微信硬编码，P1 要通用化**） |
| P0-3 焦点/遮挡 fail-fast | `80e0595` | done（已基本通用） |

## P1 — 通用快路径（已落地 `78ea80b`，非微信特化）

### P1-A 去 App 特化，保留「激活」语义 ✅
- 已删除：`current_chat_name_label`、`session_item_*`、窗口名 `微信|WeChat|Weixin`、`readChatOpenState`
- `isActivatableSelectionItem`：`ListItem|TreeItem|TabItem|MenuItem` — **Select ≠ 激活**
- 廉价后置条件：局部非 Selected 状态变化 / 窗口 title 含目标名 / before→after title 变化
- 不满足 → `needs_fallback_click` → **一次** HID → 再验；仍失败交回上层

### P1-B 点击/激活短路径 ✅
- Select 无激活证据立刻 HID；有可信 UIA 元素时主路径不先 vision
- sleep/超时收紧：UIA verify 40ms；UIA 3.5/4.5s；HID verify 5s；前台探测 4s

### P1-C 输入短路径 ✅（最小）
- ValuePattern 优先；失败 focus+SendKeys（未做昂贵二次 Value 回读）

### 明确不做
- 不为任何单 App 维护 AutomationId 白名单 / 场景路由
- 不搞 App adapter 框架（YAGNI）
- 不重写 computer-use provider 接线

## P2 — 准确性增强（继续，不挡 P1）

UIA 打分 / OCR→UIA 邻域 / selector 主工作流 —— 已有基础则小步补齐，不为加速另起炉灶。

## P3 — 暂缓

Swift daemon 大迁、纯视觉主导执行器、非 Windows。

## 建议实施顺序（更新）

```
P0 通道自愈 + 选中校验 + 焦点（已完成）
 → P1-A 去掉微信硬编码，换成通用激活后置条件
 → P1-B 点击短路径 / 早停 / 收紧超时
 → P1-C 输入短路径
 → P2 准确性剩余项
```

## 回归口径（通用，不再绑死探活文案）

| 指标 | 门槛 |
|---|---|
| `PowerShell process not available` | 0 |
| ListItem「仅选中未激活」误报成功 | 0 |
| 有 UIA 目标时额外 vision 触发 | 应显著下降 |
| 单次 click_element 主路径 | 优先 < 3s（热壳） |
| 代码中微信专用字符串/AID | 0 |

## 非目标

- 不靠 Agent「多试几次」掩盖工具慢/不稳
- 不把旁路临时 `.ps1` 当产品能力
- 不因探活扩写成无关模块大重构
