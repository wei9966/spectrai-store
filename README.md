# SpectrAI Store

SpectrAI 官方插件仓库，提供 MCP Server 和 Skill 的一站式安装。

## 可用插件

### MCP Servers

| 名称 | 描述 | 平台 | 版本 |
|------|------|------|------|
| [spectrai-claw](./mcps/spectrai-claw) | 桌面自动化（截图、鼠标键盘、UIA、窗口管理） | Windows | 0.1.0 |

### Skills

即将推出...

## 安装方式

### 方式一：通过 SpectrAI 内置安装

在 SpectrAI 会话中让 AI 帮你安装：

> 帮我安装 spectrai-claw

### 方式二：手动安装

```bash
# 克隆仓库
git clone https://github.com/wei9966/spectrai-store.git

# 安装依赖
cd spectrai-store/mcps/spectrai-claw
npm install

# 启动
npm start
```

## 目录结构

```
spectrai-store/
├── registry.json      ← 插件注册清单
├── mcps/              ← MCP Server 插件
│   └── spectrai-claw/
└── skills/            ← Skill 插件（即将推出）
```

## 贡献

欢迎提交 PR 贡献新的 MCP 或 Skill 插件。

## License

MIT
