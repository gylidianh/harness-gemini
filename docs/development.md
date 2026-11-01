# 源码与开发

对应 Harness Gemini 1.3.10。返回 [项目首页](../README.md)。

## 包含哪些内容

```text
app/
  desktop/       Electron 主进程、预加载、浏览器、通知与桌宠
  server/        本地 HTTP 服务、模型请求、存储、工具与技能
  shared/        桌面端与服务端共用逻辑
  dist/          已构建的基础界面和可读的新增 UI 模块
  build/         应用图标
  third-party/   第三方许可与来源说明
tools/           开发启动、校验与打包工具
tests/           使用独立临时数据的服务测试
```

应用文件从已发布的 1.3.10 程序归档中提取。`SOURCE-MANIFEST.json` 保存原始文件的 SHA-256，不包含本机路径；依赖通过锁文件安装，`node_modules` 不入库。

基础界面的原始 React / Vite 工程没有找到，本仓库只保留其编译产物。`dist/composer-controls.js`、`settings-layout.js`、`skills-ui.js`、`model-selector.js` 等新增 UI 模块是可读源文件。可以修改这些模块、桌面端和服务端，再随现有前端产物打包；不能从此仓库重新生成基础界面的 `dist/assets/index-*.js`。

## 获取源码

源码直接保存在仓库的 `main` 分支。打开 [app 源码目录](../app/) 即可在线逐层浏览文件，也可克隆仓库：

```powershell
git clone https://github.com/gylidianh/harness-gemini.git
cd harness-gemini
```

原 `v1.3.10` 标签在源码上传前已发布，保持原样；查看本次补充的源码请使用 `main` 分支。

## 环境与安装

- Node.js 22.12 或更新版本，附带 npm。
- 桌面功能及 Windows 安装包使用 Windows x64。
- 某些外置技能还需要 Python、PowerShell 或相应应用，具体见技能说明。

在仓库根目录执行：

```powershell
npm ci
npm ci --prefix app
```

根目录安装 Electron 和打包工具，`app/` 安装程序依赖。Electron 安装过程可能需要下载运行时。

## 开发运行

桌面版：

```powershell
npm run desktop
```

仅运行本地 HTTP 服务：

```powershell
npm start
```

服务默认监听 `http://127.0.0.1:4318`，可通过 `PORT` 环境变量更改端口。

这两个开发命令将数据放在仓库内被 Git 忽略的 `.local-data/` 和 `.local-workspace/`，不读取已安装程序的正常数据目录。开发数据不会随源码或安装包发布。

仅 Node.js 服务模式使用的密钥存储方式与桌面版不同：没有 Electron 系统密钥保护时，开发数据中的密钥以明文保存。请使用测试配置；需要真实连接时优先使用桌面版。

## 检查与测试

```powershell
npm run check
npm run verify:release
npm test
```

- `check` 检查源码中的本机路径、疑似凭据、意外数据文件和 JavaScript 语法。
- `verify:release` 比对应用文件与原始 1.3.10 归档的校验值。代码修改后出现差异是预期结果。
- `test` 启动独立临时服务，验证版本、界面资源、配置掩码和会话创建，不请求外部模型。

可在 Windows 上运行 `npm run smoke:desktop` 做桌面集成自检。结果保存在独立 `.local-data/smoke-*/report.json`。桌宠置顶等检查受桌面环境影响；应查看具体检查结果，不能把部分通过当作全部通过。

## Windows 打包

```powershell
npm run build:win
```

输出位于被 Git 忽略的 `release/`。打包使用当前 `app/` 源码与已有前端产物，保留应用标识和升级路径，不包含开发数据。

自行构建的安装包可能因依赖解析、构建工具或时间戳不同而具有不同校验值。公开发行的 1.3.10 安装包仍以原 Release 的 SHA-256 为准，本次上传源码不替换该安装包。

## 隐私与许可

不提交配置、密钥、会话、日志、工作文件、依赖目录或本机开发脚本。截图只能使用演示数据。自动扫描不能代替提交前审阅。

保留 `app/THIRD-PARTY-NOTICES.md`、`app/third-party/` 及 `app/dist/provider-brands/` 中的许可与来源说明。项目自身的代码许可尚未另行声明，不为第三方代码或商标新增授权。
