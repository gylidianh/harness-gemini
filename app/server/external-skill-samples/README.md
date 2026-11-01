# Harness Gemini 外置技能

这个文件夹里的每个子文件夹都是一个**外置技能**：一个脚本，加上一份说明它的 `skill.json`。
模型会在每一轮请求前重新读取这里，把每个启用的技能当作一个名为 `ext_<name>` 的工具，
看到它的说明和参数后自己决定什么时候调用。新加或修改的技能**下一轮就能用**，不用重启。

## 目录结构

```
外置技能目录/
  read_pdf/
    skill.json      ← 技能说明（必需）
    read_pdf.py     ← 脚本
```

## skill.json

```json
{
  "name": "read_pdf",
  "description": "模型据此判断何时调用：写清楚它能做什么、什么时候该用。",
  "command": ["read_pdf.py"],
  "readOnly": true,
  "pathParameters": ["path"],
  "timeoutMs": 120000,
  "parameters": {
    "type": "object",
    "properties": { "path": { "type": "string", "description": "PDF 路径" } },
    "required": ["path"]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 2–40 个小写字母、数字或下划线，以字母开头；工具名为 `ext_<name>` |
| `description` | 必填，模型靠它判断什么时候调用 |
| `command` | 要运行的命令。第一项是脚本时按扩展名选解释器：`.py` 用 python，`.js/.mjs/.cjs` 用应用自带的 Node 运行时（桌面版无需另装 Node.js），`.ps1` 用 PowerShell，`.cmd/.bat` 用 cmd。也可以写 `["node", "index.mjs"]` 或任意可执行程序。技能文件夹里的相对文件名会自动换成完整路径；`{skillDir}`、`{workspace}` 会被替换 |
| `parameters` | 参数的 JSON Schema（根 type 为 object）。为了兼容 Gemini，每个参数推荐只声明一种 type；例如集装箱号声明为 array，单个箱号也传一项列表。旧版 type 数组在运行时会转换为首个非 null 类型供模型使用，脚本调用仍按原始类型定义校验；不会改写用户自定义的 skill.json |
| `readOnly` | 由作者声明该技能只读不改文件。只读技能在聊天模式也可用，在「帮我批准」模式下处理工作目录内的文件时无需逐次批准。应用无法强制检查，请只给真正只读的脚本加上 |
| `pathParameters` | 哪些参数是文件路径；指向工作目录之外时按权限规则请求批准 |
| `timeoutMs` | 单次运行时限，1000–600000，默认 60000 |
| `enabled` | 设为 `false` 可暂时停用 |

## 脚本怎么写

- 参数以 **JSON** 从**标准输入**传入。
- 结果打印到**标准输出**：打印 JSON 会被解析后交给模型，其他内容按文本返回（最多约 400 KB）。
- 工作目录是当前会话的工作目录；环境变量 `HARNESS_WORKSPACE`、`HARNESS_SKILL_DIR`、`HARNESS_SKILL_NAME` 可供使用。
- 退出码非 0 视为失败，标准错误输出会一并交给模型。

## 让模型看图片（1.2.3 起）

脚本可以把图片交给模型直接观察（模型需支持图片输入）：把 PNG、JPEG 或 WebP 写到**工作目录**里，
再在 JSON 结果中加一个 `images` 数组：

```json
{ "text": "...", "images": [ { "path": "pdf_pages/合同_p3.png", "label": "合同第 3 页" } ] }
```

- 每项可以是路径字符串，或 `{ path, label, page, tile, tiles, width, height, dpi }`。
- 应用会读取这些文件，作为真实图片随本轮请求交给模型，不经过标准输出（避免 400 KB 上限）。
- 限制：只接受工作目录内的文件（按真实路径判断）；单次最多 6 张、单张 5 MB、合计 15 MB；按文件内容识别格式。
- 结果中的 `images` 会被改写为每张图的交付情况（`delivered`，失败时附 `reason`）。
- 例子：`read_pdf` 把扫描页渲染到 `pdf_pages/` 后用这个方式交给模型。

## 权限

运行脚本等同于运行命令：

- **完全访问权限**：直接运行。
- **帮我批准**：声明了 `readOnly` 且路径参数都在工作目录内时直接运行，否则请求批准。
- **请求批准**：每次运行前请求批准。
- **聊天模式**：只提供声明了 `readOnly` 的技能。

也可以直接让模型帮你写：例如「写一个把 Word 转成文字的脚本，做成外置技能」。
