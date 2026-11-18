# HSCIQ MCP 商品归类工具

这是原生无状态 Streamable HTTP MCP 客户端，不是模型供应商。官方文档：https://www.hsciq.com/MCP/Docs 。默认端点 https://www.hsciq.com/mcp/rpc （不要加入 /MCP）。独立实现，未复制或执行 cc-haha 参考代码。

## 配置
1. 在启动 Harness 前，通过系统用户环境变量设置 `HSCIQ_API_KEY` 为自己在 HSCIQ 获取的 API key，然后完全退出并重启应用。不要把密钥写进对话、skill.json、命令历史或截图。
2. 设置→外置技能→打开技能文件夹。`hsci_query` 为13个官方只读工具+目录发现；`hsci_mcp` 允许全部调用（包括写入）。使用现有开关开启/关闭。
3. 在对应目录 `skill.json` 的 `mcp` 中可修改 `endpoint`、`apiKeyEnv`、`auth`（`x-api-key` 或 `bearer`）。这里仅保存环境变量名，禁止保存明文key。刷新技能后生效。
4. HTTPS必需；仅本机模拟测试可用HTTP。禁止重定向及URL内嵌凭据、查询参数。此版本只支持HSCIQ无状态免握手模式，不承诺兼容需要initialize/session的其他MCP服务器。

## 使用
先调用 `ext_hsci_query` 参数 `{"action":"list"}` 获取最新工具说明及 inputSchema。再按真实 schema 调用，例如 `{"action":"call","name":"search_code","arguments":{"keywords":"塑料杯","country":"CN","pageIndex":1,"pageSize":10}}`。工具会自动遍历 tools/list 分页。不要猜测其他必填参数。

`hsci_query` 的只读许可来自本地13名称白名单，远端 annotations 不能授权；未知工具和 `create_guilei_form`、`add_guilei_dialog_message` 被拒绝。`hsci_mcp` 为可写技能，在智能/询问权限模式需批准；聊天只读模式不会提供它。完全访问模式遵循现有自动执行策略。即使只读查询也会把参数发到远端，可能消耗配额；不自动重试任何请求。

创建归类表单使用 `ext_hsci_mcp`，`action:"call"`、`name:"create_guilei_form"`、`arguments` 填写 tools/list 指定的商品信息，另传 `imagePaths:["images/front.jpg"]`。只能上传当前会话工作目录内的真实路径，最多3张、每张非空且≤1MiB、JPG/PNG/GIF/WebP魔数校验；自动变成 `images:[{fileName:"front.jpg",data:"base64..."}]`。不能同时传 arguments.images。外部文件须先通过正常文件审批复制到工作目录。不支持绕过权限的外部路径/目录/符号链接目标。使用本地路径避免模型工具参数大小限制；直接base64虽然MCP技能支持5MiB，模型provider仍有256KB限制。

上传会向配置的 endpoint 发送文件内容。审批拒绝后不会运行客户端。返回 content、structuredContent、isError 保留在报告 result，HTTP200的isError也会标记ok:false，不重试。唯一例外是与当前API key完全相同的返回字符串片段会替换为[REDACTED]，防止远端错误或恶意回显泄密。JSON/SSE受超时和8MiB响应限制；工具目录最多100页/1000项。

新版本仅一次性添加模板，不覆盖已有同名目录，不恢复用户后续删除的模板。环境变量仅在服务进程中使用；没有修改模型API配置。
