# Harness Gemini

Windows 桌面 AI 工作台，在一个窗口中聊天、编程、生图和浏览网页。

[![版本](https://img.shields.io/github/v/release/gylidianh/harness-gemini)](https://github.com/gylidianh/harness-gemini/releases/latest)
![Windows x64](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0078d4)

**[下载 2.0.5 安装包](https://github.com/gylidianh/harness-gemini/releases/download/v2.0.5/Harness-Gemini-2.0.5-win-x64.exe)** · **[浏览源码](app/)** · [版本说明](CHANGELOG.md) · [使用指南](docs/usage.md) · [开发说明](docs/development.md) · [常见问题](docs/faq.md)

![Harness Gemini 1.4.4 主界面](docs/images/home-1.4.4.png)

## 2.0.5 更新

- 手机远程新增**会话正文阅读**：点击「会话」列表或「待办 → 进行中」卡片中的「查看正文」，即可直接查看历史消息与正在生成的回复正文，并支持加载更早消息、展开长文、按需查看思考过程、停止生成及底部直接追问。
- 采用零协议破坏的分片传输方案：严格保持 8 KiB 明文 / 12 KiB 信封上限不变（已部署的 VPS 中继 `server.mjs` 与 `relay-protocol.mjs` 无需修改），单帧预留约 300B 包裹空间、按真实 UTF-8 JSON 字节预算切片并在 Unicode 码点边界对齐，不截断 emoji 与代理对。
- 生成中的回复每 2.5 秒自动增量追尾，不重复传输已读正文；仅投影正文与精简工具状态摘要，不暴露工具原始输出、参数、密钥或附件二进制；内置转义安全 Markdown 渲染。
- 使用自建 VPS 中继时，只需更新 `relay-server/phone.html` 并刷新手机页面；免服务器直连（局域网 / Cloudflare 隧道）升级桌面端后直接生效。

## 功能

| 功能 | 说明 |
| --- | --- |
| 模型连接 | 支持 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses 协议；可保存和切换多个连接 |
| 聊天、编程、生图 | 为不同模式配置模型，在输入框工具栏中切换 |
| 模型与思考等级 | 从工具栏选择模型；推理参数是否生效取决于模型和接口支持 |
| 内置浏览器 | 多标签页、网页读取与交互、文件下载与进度显示，也可打开本地页面 |
| 技能与子代理 | 管理外置技能，查看任务清单和子任务进度 |
| 界面与上下文 | 五种主题、Markdown 与公式、附件、上下文占用和压缩设置 |

## 开始使用

1. 下载并安装 Windows x64 版本，无需另外安装 Node.js。
2. 打开左下角 **设置 → 供应商**，填写接口地址、协议和模型；需要鉴权的服务再填写 API Key。
3. 点击 **保存并使用**，在输入框中选择模式、模型、权限和思考等级。
4. 输入消息开始使用。右侧工作空间默认收起，可通过顶部面板按钮展开。

已有安装的用户，请先退出旧程序，再运行新安装包覆盖升级。设置、会话和工作目录继续保留。

详细步骤、文件校验和数据位置见 [使用指南](docs/usage.md)。

## 界面

输入工具栏集中显示附件、模式、权限、模型、思考等级和发送按钮；设置使用左侧分类、右侧内容的布局。

<details>
<summary>查看输入工具栏</summary>

![输入工具栏](docs/images/composer-1.4.4.png)

</details>

<details>
<summary>查看设置与技能管理</summary>

![设置与技能管理](docs/images/settings-1.4.4.png)

</details>

<details>
<summary>查看内置浏览器下载进度</summary>

![内置浏览器下载进度](docs/images/download-1.4.4.png)

</details>

以上截图拍摄于 1.4.4，来自独立演示环境，连接和模型名称为示例，不包含真实密钥、聊天记录或用户文件。

## 数据与权限

- 设置、会话和产物保存在本机。模型请求发送到你配置的服务；联网工具会访问对应网站。
- 桌面版使用 Windows 系统密钥保护加密保存 API Key，已保存的密钥默认以掩码显示。
- 工具操作受所选权限模式和审批结果控制。编程命令以当前 Windows 用户权限执行，会话目录不是系统沙箱。
- 发布附件只包含程序与运行依赖，不携带维护者的本机配置、会话、日志或工作文件。

更多说明见 [数据位置与权限](docs/usage.md#数据位置与权限)。

## 下载、文档与反馈

本仓库维护 Windows 安装包、可用源码和使用文档。

- [当前版本与全部下载](https://github.com/gylidianh/harness-gemini/releases/latest)
- [更新记录](CHANGELOG.md)
- [使用指南](docs/usage.md)
- [源码范围、运行与打包](docs/development.md)
- [常见问题](docs/faq.md)
- [报告问题](https://github.com/gylidianh/harness-gemini/issues/new/choose)
- [参与维护](CONTRIBUTING.md)

## 源码范围

[app/](app/) 包含 2.0.5 的桌面端、服务端、手机页和前端源码；[app/ui/](app/ui/) 可重新生成界面。自建中继见 [relay-server/](relay-server/)。

## 贡献者

1. [@gylidianh](https://github.com/gylidianh)
2. [@nexou9527](https://github.com/nexou9527)

## 致谢

项目使用 Electron、React、Express、KaTeX、react-markdown、lucide 和 undici 等组件。内置浏览器界面、上下文统计及附件功能部分改编自 [ZCode](https://github.com/zai-org/ZCode)。部分供应商图标来自 [LobeHub Icons](https://github.com/lobehub/lobe-icons) 和供应商站点。完整第三方许可与来源说明随程序附带，见 [第三方声明](app/THIRD-PARTY-NOTICES.md)、[第三方许可](app/third-party/) 和图标目录中的许可文件。
