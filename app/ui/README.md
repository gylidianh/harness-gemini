# Harness Gemini UI 开源前端工程 (`src152/ui`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933.svg)](../package.json)
[![React](https://img.shields.io/badge/React-19-149eca.svg)](../package.json)

欢迎来到 **Harness Gemini** 的开源前端源码工程目录。本项目采用标准 **[MIT License](./LICENSE)** 开放源代码，致力于提供一套完全透明、模块化、可读易改、零黑盒工具链依赖的现代 AI 桌面工作台前端实现。

---

## 1. 开源声明与工程理念

- **开源许可协议**：本前端工程及所属仓库采用标准 **MIT License**（`Copyright (c) 2026 Harness Gemini Contributors`），允许自由使用、复制、修改、合并、发布与二次分发（涉及的上游组件归属声明详见 [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)）。
- **告别压缩黑盒 Bundle**：彻底替代早期单行混淆压缩的 `dist/assets/index-BWW8q4t7.js` 与 `dist/assets/index-BbYfWXft.css`，将全部 React 19 视图组件、SSE 流式状态机、内置浏览器面板、扩展工作台模块及分层 CSS 还原为结构清晰、命名语义化的可读源码。
- **零外部构建器依赖**：无需额外安装庞大复杂的打包器（无外部 Vite / Webpack 编译锁死），仅依赖 Node.js（`>= 22.12`）内置标准库即可通过 `npm run build:ui` 一键同步生成生产目录 `src152/dist/`，并通过 `npm run verify:ui` 完成全链路静态审计与视觉规范校验。
- **现代开源极简美学**：遵循「通透留白、柔和圆角、温润护眼配色、1px 细腻描边替代厚重阴影」的视觉准则，支持多套可热切换主题皮肤，100% 保留原有快捷键、多模态对话、Agent Teams 看板、对话地图与内置浏览器能力。

---

## 2. `src152/ui/` 目录结构说明

```text
src152/ui/
├── index.html                # 前端 HTML 入口模板（遵循 CSP script-src 'self'，外部 ESM 加载）
├── LICENSE                   # 标准 MIT 开源许可证
├── README.md                 # 前端二次开发与主题定制指南（本文档）
├── src/                      # 核心 React 19 模块化源码
│   ├── main.js               # 应用挂载入口（挂载至 #root）
│   └── ...                   # 侧边栏、聊天主画布、Markdown/KaTeX 渲染、SSE 流、
│                             # 附件管理、技能库、设置抽屉与内置响应式浏览器面板等模块
├── modules/                  # 独立功能工作台与扩展交互模块（与主应用协同或独立挂载）
│   ├── conversation-map.js   # 「工作空间 → 对话地图」时间轴导航与跨消息全文搜索
│   ├── team-panel.js         # Agent Teams 多智能体协作看板（常驻 #root 外防重渲染丢失）
│   ├── team-view.js          # 团队任务拓扑与成员状态视图辅助
│   ├── model-selector.js     # 多供应商模型选择器与快速切换面板
│   ├── mcp-settings.js       # MCP (Model Context Protocol) 服务配置管理
│   ├── session-tools.js      # 会话级工具栏、导出与快捷操作
│   ├── file-changes.js       # 工作区文件变更对比与审阅面板
│   ├── usage-stats.js        # Token 消耗与模型调用统计面板
│   ├── reply-ui.js           # 引用回复与上下文追问交互
│   ├── branch-ui.js          # 对话分支管理与切换视图
│   ├── remote-settings.js    # 远程连接与二维码配对设置
│   ├── composer-controls.js  # 底部输入栏增强控件与模式切换
│   └── ...                   # 其他辅助模块（skills-ui、computer-settings、qr-code 等）
├── styles/                   # 分层设计令牌（Design Tokens）与全局视觉样式
│   ├── main.css              # 应用主样式入口（按级联顺序组织全局层样式）
│   ├── katex.css             # KaTeX 数学公式排版与本地 .woff2 字体声明
│   ├── tokens.css            # :root 核心设计令牌（表面、线条、字色、圆角、微阴影与字体栈）
│   ├── base.css              # 现代极简全局重置、滚动条与通用按钮基础原语
│   ├── layout.css            # 应用三栏壳层、左侧会话栏、顶栏与响应式骨架
│   ├── chat.css              # 欢迎页、消息阅读流、Markdown 代码块、工具调用时间轴与附件渲染
│   ├── composer.css          # 底部输入器（Composer）、技能菜单、模式切换与附件芯片
│   ├── panels.css            # 右侧工作空间容器、内置浏览器面板、设置抽屉与模态弹窗
│   ├── themes.css            # 多套内置主题皮肤（gemini-dark / claude / luxe-noir / luxe-ivory）
│   └── modules/              # 16 个独立扩展面板与工作空间专属样式表（构建同步至 dist/*.css）
│       ├── workspace-tabs.css    # 工作空间顶部标签栏（含扩展标签 span 透明无阴影重置）
│       ├── conversation-map.css  # 对话地图面板与无阴影时间轴节点卡片样式
│       ├── team-panel.css        # 多智能体团队看板样式
│       ├── model-selector.css    # 模型选择器浮层与品牌图标样式
│       ├── settings-ui.css       # 设置抽屉与表单控件样式
│       ├── advanced-settings.css # 高级参数设置样式
│       ├── mcp-settings.css      # MCP 服务器管理面板样式
│       ├── remote-settings.css   # 远程连接设置样式
│       ├── computer-settings.css # 桌面操控权限与设置样式
│       ├── session-tools.css     # 会话工具栏样式
│       ├── file-changes.css      # 文件变更对比视图样式
│       ├── usage-stats.css       # 用量统计面板样式
│       ├── composer-controls.css # 输入器快捷控件样式
│       ├── reply-ui.css          # 引用回复气泡与控件样式
│       ├── branch-ui.css         # 对话分支切换器样式
│       └── ui-port.css           # 端口与扩展兼容补丁样式
├── vendor/                   # 本地化前端运行时依赖封装（React 19、Lucide 图标、Markdown/KaTeX 等离线 ESM）
├── assets/                   # 静态资源（KaTeX 数学字体、品牌字标、provider-brands 供应商图标等）
└── scripts/                  # 纯 Node.js 内置模块实现的构建与校验工具
    ├── build.mjs             # 一键构建脚本：将 src152/ui/ 组装输出至 src152/dist/
    └── verify-ui.mjs         # 自动化校验脚本：开源合规、资源完整性、JS 语法与 CSS 视觉规则审计
```

---

## 3. 快速上手与二次开发指南

### 3.1 环境准备

确保本机已安装 **Node.js `>= 22.12`**（无需全局安装任何第三方打包 CLI）：

```powershell
node -v
# 建议输出 v22.12.0 或更高版本
```

### 3.2 日常修改工作流

1. **修改核心界面布局与 React 组件**
   - 前往 `src152/ui/src/` 编辑对应的 ES Module 组件文件（例如侧边栏会话列表、欢迎页卡片、消息气泡渲染、底部输入器或内置浏览器视口组件）。
2. **修改工作空间扩展面板**
   - 前往 `src152/ui/modules/` 编辑独立功能脚本（如 `conversation-map.js`、`team-panel.js`、`model-selector.js`、`file-changes.js` 等），并在 `src152/ui/styles/modules/` 中调整同名 CSS 样式。
3. **修改全局配色、圆角、留白与阴影策略**
   - 前往 `src152/ui/styles/tokens.css` 与 `src152/ui/styles/themes.css` 编辑 `:root` 设计令牌与 `[data-skin="..."]` 皮肤规则。

### 3.3 一键构建生成 `src152/dist/`

每次修改完 `src152/ui/` 下的源码或样式后，在 `src152/` 目录下运行：

```powershell
cd .\app
npm run build:ui
```

该命令执行 `node ui/scripts/build.mjs`，自动清理旧版压缩黑盒产物并将最新的可读模块化代码、分层样式表、16 个扩展模块样式、KaTeX 字体与图标资源完整同步至 `src152/dist/`。

### 3.4 运行自动化完整性校验

在提交更改或打包安装包前，运行内置校验器确认工程状态：

```powershell
cd .\app
npm run verify:ui
```

如需在 CI 脚本中仅获取结构化 JSON 输出，可附加 `--json` 参数：

```powershell
node ui/scripts/verify-ui.mjs --json
```

`verify-ui.mjs` 会自动执行以下 6 大类检查（任一未通过均以非 `0` 退出码报错）：
- 三级 `LICENSE` 文件存在且符合标准 MIT 协议；
- `src152/package.json` 包含 `"license": "MIT"`、`"build:ui"` 与 `"verify:ui"` 脚本且保留全部核心依赖；
- `src152/ui/` 源码目录结构与文档齐全；
- `src152/dist/index.html` 引用的全部本地 `.js` / `.mjs` / `.css` 资源（及 CSS `@import` 链）在 `src152/dist/` 中真实存在且非空，满足桌面端 `smoke.mjs` 所需的 `#root`、ESM 入口与 KaTeX `.woff2` 字体魔数校验；
- 对 `src152/ui/` 与 `src152/dist/` 下全部 `.js` / `.mjs` 文件执行并发 `node --check` 语法校验；
- 校验 `workspace-tabs.css` 与 `conversation-map.css` 已包含针对 `#hg-cmap-tab > span` / `.hg-cmap-tab > span` 的透明无阴影重置规则及 `.hg-map-card` 无阴影规则。

### 3.5 重新打包 Windows 桌面安装包 (`build201.ps1`)

当 `npm run build:ui` 与 `npm run verify:ui` 全部通过后，可在仓库根目录调用打包脚本生成全新的 Windows x64 NSIS 安装程序：

```powershell
# Run from the repository root
npm run build:win
```

打包流程说明：
- `build201.ps1` 会进入 `installer/` 目录，调用 `electron-builder` 读取 `installer/builder-201.json`；
- 自动将 `src152/`（含最新的 `dist/**/*`）与离线 `electron-dist/` 封装为桌面安装包；
- 构建产物输出路径：`installer/out201/Harness-Gemini-2.0.1-win-x64.exe`；
- 构建日志与退出码分别保存在 `installer/build-201.log` 与 `installer/build-201.exit`（值为 `0` 代表打包成功）。

---

## 4. 二次开发关键架构契约（必读）

为确保桌面端安全沙箱与自动化冒烟测试（`src152/desktop/smoke.mjs`）100% 通过，二次开发时请遵守以下契约：

1. **严格的 CSP 外部脚本策略（禁内联 Script）**
   - 本地服务启用了 `default-src 'self'; script-src 'self'` 响应头。请勿在 `index.html` 中添加任何内联 `<script>...</script>` 代码块或 `onclick="..."` 内联事件，所有脚本均须通过外部 `.js` / `.mjs` 文件加载。
2. **`desktop/smoke.mjs` 自检契约**
   - `index.html` 必须包含 `<div id="root"></div>` 挂载点及至少一个 `<script type="module" src="..."></script>`；
   - `index.html` 前 30 个 `<link>` / `<script>` / `<img>` 标签引用的所有本地文件必须返回 HTTP 200 且内容非空；
   - `smoke.mjs` 只扫描 `index.html` **直接 `<link rel="stylesheet" href="...">`** 样式表中的 `url(...woff2)` 来验证数学公式字体（不递归追踪 CSS `@import`），因此包含 KaTeX `@font-face` 的 `/styles/katex.css` 必须在 `index.html` 中直接 `<link>` 引入。
3. **工作空间标签栏计数徽标隔离规范**
   - 在扩展工作空间顶部标签（如「对话地图」`#hg-cmap-tab` / `.hg-cmap-tab` 或「团队」`#hg-team-tab`）中放置文字标题 `<span>` 时，必须在 `workspace-tabs.css` / `conversation-map.css` 中显式重置 `background: transparent; box-shadow: none; padding: 0; border-radius: 0;`，防止文字底部出现胶囊色块或阴影污染；同时 `.hg-map-card` 统一保持 `box-shadow: none` 的清爽无阴影卡片形态。

---

## 5. 设计系统与主题令牌（Design System & Theme Tokens）

Harness Gemini 前端全面采用 **CSS 自定义属性（CSS Custom Properties）** 驱动视觉表现（定义于 `src152/ui/styles/tokens.css` 与 `themes.css`）。所有核心组件与扩展面板均通过语义令牌取色，严禁硬编码刺眼纯黑阴影或突兀色值。

### 5.1 核心 CSS 令牌速查表

| 令牌分类 | 变量名称 | 用途说明 |
| :--- | :--- | :--- |
| **画布与表面** | `--bg` | 应用主画布背景色（聊天阅读区底色，追求温润护眼） |
| | `--sidebar` | 左侧会话栏、代码块底色及次级分组容器背景色 |
| | `--panel` / `--input-bg` | 右侧工作空间面板底色 / 搜索与输入控件柔和填充色 |
| | `--surface` | 顶栏、输入器（Composer）、设置卡片等一级承载表面 |
| | `--surface-raised` | 弹出菜单、下拉浮层、模态框等高阶表面 |
| **分割与描边** | `--line` | 全局 1px 轻量级区域分割线与常规卡片边框 |
| | `--line-strong` | 输入框、按钮轮廓、悬停态强调边框 |
| **排版文字色** | `--text` | 一级正文与标题主文字颜色 |
| | `--text-secondary` | 二级正文、列表常规项文字颜色 |
| | `--muted` | 次要说明、图标默认色、未激活标签颜色 |
| | `--subtle` | 占位符（Placeholder）、时间戳、快捷键提示等弱化文字 |
| **品牌强调色** | `--accent` | 品牌主交互色（主按钮、激活态指示条、链接、焦点环） |
| | `--accent-hover` | 主交互色悬停加深态 |
| | `--accent-deep` | 浅色高亮背景上的深色强调文字 |
| | `--accent-tonal` | 温和低饱和度主色底纹（激活标签背景、选中芯片底色） |
| | `--accent-tonal-strong` | 选中态边框或文本选区（`::selection`）底色 |
| | `--on-accent` | 填充型主色按钮上的前景文字色（如 `#ffffff`） |
| **语义状态色** | `--green` / `--green-tonal` | 连接正常、任务完成、新增代码行状态色及柔和底色 |
| | `--amber` / `--amber-tonal` | 工具待审批、运行警告状态色及柔和底色 |
| | `--red` / `--red-tonal` | 运行错误、删除确认、危险按钮状态色及柔和底色 |
| **交互与圆角** | `--hover` / `--hover-strong` | 列表项与图标按钮的半透明悬停叠色 |
| | `--focus-ring` | 无障碍键盘与输入框聚焦光环 |
| | `--radius-xs` ~ `--radius-2xl` | 圆角阶梯（`6px` / `8px` / `12px` / `16px` / `20px` / `24px`） |
| | `--radius-full` | 胶囊态圆角（`999px`） |
| | `--shadow-1` ~ `--shadow-4` | 极度克制的弥散浮层阴影令牌（仅用于顶层弹出菜单与模态框，常规卡片一律无阴影） |
| **布局与字体** | `--sidebar-width` / `--header-height` / `--chat-min-width` | 侧边栏宽度、顶栏高度与中央画布最小保障宽度 |
| | `--font-sans` / `--mono` | 全局无衬线 UI 字体栈与等宽代码字体栈 |

### 5.2 内置主题皮肤一览

系统通过根节点 `html[data-skin="<skin-id>"]` 与 `.app-shell[data-skin="<skin-id>"]` 属性选择器实现即时换肤：

- `classic`（默认 `:root`）：现代极简暖白明亮主题，通透清爽、长时间阅读不刺眼；
- `gemini-dark`：深邃低眩光暗色主题，适合夜间编码与沉浸式对话；
- `claude`：温润书卷纸感主题，搭配衬线标题与暖陶棕强调色；
- `luxe-ivory`：暖玉象牙浅色主题，柔和米白底色配流金铜点缀；
- `luxe-noir`：黑金典藏暗色主题，深曜石底色配香槟金微光边框。

### 5.3 如何自定义或新增一套皮肤

只需三步即可为 Harness Gemini 添加专属主题皮肤（以新增 `nord-mist` 极地雾蓝皮肤为例）：

**第 1 步：在 `src152/ui/styles/themes.css` 中声明皮肤变量**

```css
html[data-skin="nord-mist"],
.app-shell[data-skin="nord-mist"] {
  color-scheme: light;
  --bg: #f4f7fa;
  --sidebar: #ebf0f5;
  --panel: #eff3f8;
  --surface: #ffffff;
  --surface-raised: #ffffff;
  --input-bg: #eaeff5;
  --line: #dce4ec;
  --line-strong: #c8d4e0;
  --text: #24292f;
  --text-secondary: #3b4252;
  --muted: #5e6c84;
  --subtle: #8492a6;
  --accent: #3b6ea5;
  --accent-hover: #2f5b8a;
  --accent-deep: #24476e;
  --accent-tonal: #e3eef9;
  --accent-tonal-strong: #cbe0f5;
  --on-accent: #ffffff;
  --hover: rgba(36, 41, 47, 0.05);
  --hover-strong: rgba(36, 41, 47, 0.09);
}

/* 为皮肤选择器添加缩略预览卡片配色 */
.skin-preview[data-preview="nord-mist"] {
  background: #ebf0f5;
  border-color: #dce4ec;
}
.skin-preview[data-preview="nord-mist"] .skin-preview-bar {
  background: #3b6ea5;
}
.skin-preview[data-preview="nord-mist"] .skin-preview-card {
  background: #ffffff;
  border: 1px solid #dce4ec;
}
```

**第 2 步：在前端皮肤列表配置中注册皮肤项**

在 `src152/ui/src/` 的设置/皮肤定义模块中，将 `{ id: 'nord-mist', name: '极地雾蓝', subtitle: '清冷护眼雾面蓝灰配色' }` 加入可选皮肤数组（若后端 `shared/` 或 `server/` 有皮肤白名单校验，同步将该 `id` 加入允许列表）。

**第 3 步：构建并验证**

```powershell
cd src152
npm run build:ui
npm run verify:ui
```

启动应用后打开「设置 → 外观皮肤」，即可实时切换并持久化保存新主题！

---

## 6. 开源许可

本目录全部源码基于 [MIT License](./LICENSE) 开源发布。
