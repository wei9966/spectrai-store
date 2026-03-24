# SpectrAI Claw

桌面自动化 MCP Server，为 AI 提供操控桌面的能力。

## 功能

- **截图** — 全屏/区域截图，自动标注可交互元素
- **鼠标操控** — 点击、移动、滚轮
- **键盘操控** — 打字、按键、快捷键组合
- **UIA 自动化** — Windows UI Automation 元素查找与树结构获取
- **窗口管理** — 列表、聚焦、关闭窗口
- **Shell 执行** — cmd / PowerShell 命令执行
- **文件操作** — 读写文件、目录列举

## 工具列表（22 个）

| 工具 | 说明 |
|------|------|
| screenshot | 截屏并自动标注 UI 元素 |
| zoom_screenshot | 区域放大截图，带坐标网格 |
| click_element | 点击标注编号的元素 |
| screenshot_click | 按百分比位置点击 |
| mouse_click | 精确坐标点击 |
| mouse_move | 移动光标 |
| mouse_scroll | 滚轮滚动 |
| keyboard_type | 输入文本 |
| keyboard_press | 按键 |
| keyboard_hotkey | 快捷键组合 |
| uia_find_element | UIA 元素查找 |
| uia_get_tree | UIA 元素树 |
| window_list | 列出窗口 |
| window_focus | 聚焦窗口 |
| window_close | 关闭窗口 |
| get_screen_info | 获取屏幕信息 |
| shell_execute | 执行 cmd 命令 |
| shell_powershell | 执行 PowerShell |
| file_read | 读取文件 |
| file_write | 写入文件 |
| file_list | 列举目录 |
| ping | 连通性检查 |

## 安装

```bash
cd mcps/spectrai-claw
npm install
npm start
```

## 平台要求

- Windows 10/11
- Node.js >= 18
