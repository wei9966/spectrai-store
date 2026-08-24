# SpectrAI Claw 探活复盘 → 修复优先级

> 通用桌面插件；不为单 App 特化。
> 已完成：通道自愈 + 假成功治理 + 通用快点击。
> **当前焦点：点击准确率 + 速度**（找对目标、点到可点点、少空等）。

## 进度总览

| 阶段 | 解决什么 | 状态 |
|---|---|---|
| P0 | 通道断 / 选中≠激活假成功 / 焦点遮挡 | ✅ `6000693` `80e0595` |
| P1 | 去微信特化 + 通用快路径 | ✅ `78ea80b` |
| **P2** | **准确率（找对/点对）+ 速度（少 OCR/少 sleep）** | ✅ 已落地（见下） |
| P3 | Swift daemon / 纯视觉主导 | 暂缓 |

## P2 — 准确率 + 速度（本轮）

### P2-A 点得更准（准确率）
1. **OCR 只做线索**：邻域匹配不只「中心落在 bounds 内」，增加距离阈值（如 ≤24px 或短边 30%）锚到最近有 pattern 的 UIA；命中标记 `OCR_UIA`，坐标用 UIA 中心/可点点。
2. **可点点优先**：HID/坐标回退时优先 `GetClickablePoint()`，失败再用 BoundingRectangle 中心；避免点到空白/被挡区域。
3. **候选去噪**：同 bounds/同名父子重复保留有 pattern 的叶子；空名+无 pattern 降权/剔除（在现有打分上补齐，不重写框架）。
4. **解析保留 `OCR_UIA` source**（勿塌成纯 UIA/OCR），便于 click 路径识别「已锚 UIA」。

### P2-B 跑得更快（速度）
1. Chrome/Electron 强制无障碍后等待：`500ms → ≤150ms`（可配置常量）。
2. OCR 触发更苛刻：仅当**可操作 UIA（有 pattern）**过少时才跑 OCR（不要只看 `filtered.Count < 10` 的弱候选）。
3. OCR worker / vision 超时下调到够用下限（annotate OCR `20s→8s` 量级；vision `25s→10s` 量级）。
4. 有足够高分 UIA 时：跳过 OCR 整段；`click_element` 已有 UIA 则继续不进 vision。
5. 不改协议大结构；不引入 App 白名单。

### 明确不做
- 不为微信或其他 App 写 AutomationId 表
- 不重接 computer-use Windows provider 整包
- 不搞动作预算大框架（早停保持现有「Select 无证据→一次 HID」即可）

## 回归口径

| 指标 | 门槛 |
|---|---|
| OCR 文本中心误当点击目标（有邻近 UIA 时） | 应锚到 UIA |
| `GetClickablePoint` 可用时 | HID 使用可点点而非盲中心 |
| 可操作 UIA ≥ N 时 | 不启动 OCR worker |
| Chrome force 等待 | ≤150ms |
| build + 相关单测 | 全绿 |
| 业务代码微信特化字符串 | 仍为 0 |

## 非目标
- 不靠 Agent 多试几次掩盖点偏/点慢
- 不把旁路 `.ps1` 当产品能力
