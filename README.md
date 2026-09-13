# SpectrAI Store

SpectrAI 官方插件仓库，提供 MCP Server 和 Skill 的一站式安装。

## 可用插件

### MCP Servers

| 名称 | 描述 | 平台 | 版本 |
|------|------|------|------|
| [spectrai-claw](./mcps/spectrai-claw) | 桌面自动化（截图、鼠标键盘、UIA、窗口管理） | Windows | 0.5.1 |

### Skills

| 名称 | 描述 | 依赖 | 版本 |
|------|------|------|------|
| [video-shots](./skills/video-shots) | 拉片：把成片拆成逐镜头分析表（时长/景别/类别/运镜/画面），15 道质量门对账，产出单文件交互式拉片报告 | node, ffmpeg, ffprobe | 1.0.0 |
| [video-sync](./skills/video-sync) | 分镜成片：拉片数据 + 原片合成为带分镜信息的视频，镜头切了信息跟着切、镜头表自动滚动高亮 | node, ffmpeg, ffprobe, chrome | 1.0.0 |

> 以上两个技能来自开源项目 [eternityspring/reelbench-skills](https://github.com/eternityspring/reelbench-skills)（Apache-2.0），各自随附 LICENSE。

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
└── skills/            ← Skill 插件
    ├── video-shots/
    └── video-sync/
```

## 贡献

欢迎提交 PR 贡献新的 MCP 或 Skill 插件。

## License

MIT
