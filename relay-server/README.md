# Harness 远程中继（VPS 侧）

一个**只会转发的进程**：不解密、不落盘、不读正文。手机和电脑之间的每条消息都用配对密钥
派生的 AES-256-GCM 密钥封装，中继只看得到 `deviceId` 和一个密文块。

## 先看这里：现在有两种接法，这个目录只是第二种

从 1.9.0 起，桌面端自己也能接手机，不需要任何服务器：

| 接法 | 需要 VPS 吗 | 怎么走 | 后台推送 |
| --- | --- | --- | --- |
| 免服务器直连（默认） | 不需要 | 手机 → 这台电脑的局域网端口；出门时电脑自己跑 Cloudflare 隧道 | 没有 |
| 自建中继（本目录） | 需要 | 手机 → 你的 VPS → 电脑主动连出去 | 有 |

两条路**共用同一个手机页和同一套协议**：直连监听器（`app/server/remote-direct.mjs`）提供
同样的 `/pair`、`/phone/stream`、`/phone/invoke`，只是把"往 VPS 发一帧"换成"直接在本机执行"。
所以这个目录仍然值得保留：固定地址、内网穿透不用折腾、以及唯一能锁屏通知的那条路。

> **手机页的唯一来源是 `app/remote/`。** 本目录下的 `phone.html`、`sw.js`、`device-store.mjs`
> 是发给 VPS 的副本，与那边逐字节相同——`tests/remote-direct.mjs` 会核对，改一处忘了另一处会直接变红。
> 部署时按下面的 `scp` 命令把这三个文件一起传上去即可。

## 为什么是"电脑主动连出去"

Harness 主程序的服务仍然只听 `127.0.0.1`（`app/server/index.mjs` 里那条硬校验没有动）。
所以这里不开放任何入口到家里网络：桌面端启动后**主动**连 `wss/https` 到这台 VPS，家里
不用端口映射、不用改防火墙、公网 IP 变了也不影响。

## 它挡不住什么

- **它可以让你的审批迟到或被丢弃**（任何中继都做不到对抗断链）。断链时桌面端照常在本地
  排队，手机端显示"连接中断，正在重试"。
- **它知道有几次审批、大概什么时候**（消息大小与时间），也不知道内容。推送同理：它看得见
  "发了一条通知给这台手机"，看不见通知写了什么。
- **配对码仍然是单点**：拿到配对码的人可以配对成功。所以它要当密码对待：一对一用，泄漏
  就在电脑端删掉 `relay-config.json` 里的设备条目并换一个配对码。

## 部署（Debian/Ubuntu + Node 22 + Caddy）

```bash
# 1. 取代码：relay-server 整个目录（含 server/push/phone/sw/device-store）+ 一份共享协议模块
mkdir -p /opt/harness-relay/shared && cd /opt/harness-relay
scp -r user@desktop:".../relay-server/*" .
scp user@desktop:".../app/shared/relay-protocol.mjs" shared/

# 2. 生成配置
node /path/to/relay-server/make-config.mjs     # 记下 RELAY_TOKEN / PAIR_CODE_HASH / 配对码

# 3. 起服务
cat >/etc/harness-relay.env <<'EOF'
RELAY_TOKEN=前面打印的值
PAIR_CODE_HASH=前面打印的值
VAPID_PUBLIC_KEY=前面打印的值
VAPID_PRIVATE_KEY=前面打印的值
VAPID_SUBJECT=mailto:you@example.com
PORT=8790
HOST=127.0.0.1
EOF
node server.mjs        # 建议交给 systemd，见下
```

`/etc/systemd/system/harness-relay.service`：

```ini
[Unit]
Description=Harness remote relay
After=network-online.target

[Service]
EnvironmentFile=/etc/harness-relay.env
Environment=SHARED_DIR=/opt/harness-relay/shared
ExecStart=/usr/bin/node /opt/harness-relay/server.mjs
Restart=always
User=harness
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
MemoryMax=256M

[Install]
WantedBy=multi-user.target
```

Caddy（自动 TLS，反代时不要缓冲事件流）：

```
relay.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:8790 {
		flush_interval -1
	}
}
```

## 桌面端

**在应用里配置，不用再手写 JSON**：设置 → 工作台 → 远程连接，填中继地址和 `RELAY_TOKEN`
（`make-config.mjs` 打印的第二段里的值），点「启用远程连接」。

- 「显示配对二维码」里的链接带着配对密钥，摊开时等同于一把钥匙；收起即从内存里清掉。
- 设备列表可逐台撤销；撤销在**当前这条连接上立刻生效**，该设备下一帧就解不开了。
- 「轮换配对密钥」让所有手机掉线并要求重新配对，旧链接同时失效。
- 「允许手机派发新任务」默认关闭；开启后还必须**同时**满足：桌面端权限模式不是「完整访问」，
  否则远程派发会被拒绝并回一条明确提示。

配置文件仍然写在 `<用户数据目录>/data/relay-config.json`（Windows 是
`%APPDATA%\Local Harness\data\relay-config.json`），权限 0600——设置页只是它的编辑器。

## 手机端

用手机相机扫设置页里的二维码，会打开 `https://relay.example.com/#c=<配对码>`。片段不会发到
服务器，页面配对成功后立刻把它从地址栏抹掉。手动打开首页粘贴配对码也可以。

设备信息（含配对密钥）存在 IndexedDB —— 后台脚本读不到 localStorage，而它正是要在页面
关着的时候解开推送。不装 App。

### 通知

配对后点「开启通知」：页面注册 `sw.js`，向浏览器要一个推送订阅，把订阅交给中继。之后
电脑端一旦出现**新的**审批或提问，就让中继往这台手机推一条。

- **推送正文仍然是密封的**：外面是 RFC 8291 的传输加密，里面装的就是原来的密封信封。所以
  推送服务和中继都读不到是"批准"还是"回答"，只有手机上那个后台脚本解得开。
- **只响新的**：推过的 id 不会再推，断线重连也不会把昨天的事重响一遍。
- **iOS**：要「添加到主屏幕」，系统 16.4 以上；Safari 标签页里收不到。
- **VAPID 两个值要长期保留**：换掉之后每台手机都得重新点一次「开启通知」。
- 关掉通知只删订阅，配对关系还在；「本机解除配对」才是两者一起清。

### 派发任务

展开「派发任务」会先拉会话列表：最近 12 个，正在跑的标「进行中 · 」。选哪个发哪个；一个
会话都没有时直接说「还没有会话，请先在电脑上新建一个」，不自己猜。

## 接口一览

| 方法 | 路径 | 谁调用 | 认证 |
| --- | --- | --- | --- |
| GET | `/` | 手机 | 无（静态页面） |
| POST | `/pair` | 手机 | 配对码哈希 |
| GET | `/harness/stream` | 桌面（SSE） | `RELAY_TOKEN` |
| POST | `/harness/push` | 桌面 | `RELAY_TOKEN` |
| POST | `/harness/register` | 桌面 | `RELAY_TOKEN` |
| GET | `/phone/stream` | 手机（SSE） | 设备令牌 |
| POST | `/phone/invoke` | 手机 | 设备令牌 |
| GET | `/push/key` | 手机 | 无（VAPID 公钥） |
| POST | `/phone/subscribe` | 手机 | 设备令牌 |
| POST | `/phone/unsubscribe` | 手机 | 设备令牌 |
| POST | `/harness/notify` | 桌面 | `RELAY_TOKEN` |
| GET | `/sw.js`、`/phone/device-store.mjs` | 手机 | 无（静态） |
| GET | `/healthz` | 监控 | 无 |

手机页会读 `/healthz`：如果地址是 `http://`（不是安全上下文、没有 WebCrypto），页面只有在
响应里看到 `plainText: true` 时才退回明文信封。中继不返回这个字段，所以中继上一律端到端密封，
把中继架在 http 上会被页面直接拒绝，而不是悄悄降级。

日志只记 `方法 + 路径`，不记查询串、不记正文——配对码和设备令牌都不该进 access log。

## 本机自测

```bash
node tests/relay-offline.mjs      # 22 项：断线重放、越权拒绝、派发三闸门、审计
node tests/remote-settings.mjs    # 28 项：地址校验、撤销、轮换、坏配置、秘密保持
node tests/remote-ui.mjs          # 19 项：面板各状态渲染、二维码只在要求时出现
node tests/remote-layout.mjs      # 7 项：设置分区与挂载位置
node tests/qr-verify.mjs          # 40 项：二维码矩阵与参考实现逐模块比对（需 python qrcode）
node tests/push-rfc8291.mjs       # 28 项：RFC 8291 官方向量字节级比对 + 接收路径 + VAPID 签名
node tests/push-endpoints.mjs     # 28 项：订阅、推送、410 失效、解密往返、通知去重
node tests/sessions-picker.mjs    # 47 项：会话列表投影、手机页选择器与通知接线
node tests/remote-direct.mjs      # 49 项：直连监听器、两种传输、撤销、派发闸门、手机页逐字节一致
node tests/remote-tunnel.mjs      # 37 项：cloudflared 地址解析、就绪/退出/超时/停止、按需下载
```

桌面端的那三个测试不需要 Electron：面板用 react-dom/server 直接渲染。
