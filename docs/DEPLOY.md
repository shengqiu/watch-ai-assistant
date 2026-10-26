# 从零部署手册（Telegram 通道 + Cloudflare Workers）

> 目标读者：30 分钟跑通「Watch Telegram 发语音 → 云端 AI 编程助手回消息」。
> 顺序：拿 Telegram Bot 令牌 → 拿 Gemini key → Cloudflare 部署 → 注册 webhook → 手表验收 → 加固。
> 全流程 ¥0，不需要信用卡，不需要备案，不需要实名。
>
> ⚠️ 前提：Telegram 在中国大陆被墙，你的手机与 Apple Watch 需要能连 Telegram（代理/VPN）。

---

## Step 1 创建 Telegram Bot（约 2 分钟）

1. Telegram 里找 [@BotFather](https://t.me/BotFather) → 发送 `/newbot`
2. 按提示起名（如 `watch_ai_assistant`）和用户名（必须以 `bot` 结尾，如 `WatchAICoderBot`）
3. BotFather 返回一串 **HTTP API token**（形如 `123456789:AAEhBO...`）——**只显示一次，立即保存**
4. （建议）再发 `/setdescription`、`/setuserpic` 美化一下，可选

> 无需审核、无需实名、无需备案——个人 Bot 建好即用。想加 webhook 防伪，可顺手自定义一串随机串当 `TELEGRAM_WEBHOOK_SECRET`。

## Step 2 拿 Gemini API key（约 2 分钟）

1. 打开 [aistudio.google.com](https://aistudio.google.com) → Get API key → 创建
2. 免费档覆盖个人轻度使用；超额自动转按量，可在 AI Studio 页面设预算告警
3. key 格式 `AIza...`，只完整显示一次，保存好

> 只想要免费到底可以只配 Gemini；想加 fallback 厂商（deepseek 等）就去各自开放平台拿 key，后面 `wrangler secret put` 注入。

## Step 3 语音转写（可选，约 2 分钟）

**先判断你用手表哪种输入方式**——这决定要不要做这一步：

- **听写输入（推荐）**：手表上点麦克风**听写**，Apple Watch 把语音转成**文字**发给 Bot。Bot 收到文字直接处理，**完全不需要本步，跳过即可**。
- **语音条输入**：按住麦克风直接发的语音消息（OGG 音频），Bot 需下载后转写——**才需要本步**。

只有选「语音条」才继续：推荐 **Groq Whisper 免费档**——

1. 打开 [console.groq.com](https://console.groq.com) 注册 → API Keys → 创建
2. 记下：`STT_BASE_URL=https://api.groq.com/openai/v1`、`STT_API_KEY=<你的 key>`、`STT_MODEL=whisper-large-v3`

> 短编程指令（「用 gemini 帮我写个快排」）听写完全够用、还更快（Apple 本地识别，几乎瞬间出字）。建议主用听写，语音条留作备选。

## Step 4 Cloudflare 部署（约 10 分钟）

### 4.1 注册并装 CLI

1. [dash.cloudflare.com](https://dash.cloudflare.com) 注册——**免费档不绑卡**
2. 本机安装 Node 20+ 后：

```bash
cd workers-impl
npm install
```

### 4.2 注入密钥并部署

```bash
npx wrangler login                       # 浏览器授权（OAuth，免 token）
npx wrangler secret put TELEGRAM_BOT_TOKEN   # 粘贴 BotFather 的 token
npx wrangler secret put GEMINI_API_KEY
# 语音转写（配了 Step 3 才需要）：
npx wrangler secret put STT_BASE_URL     # https://api.groq.com/openai/v1
npx wrangler secret put STT_API_KEY
# 可选：webhook 防伪密钥（自定义随机串）
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

npx wrangler deploy
```

> 生产密钥必须走 `wrangler secret put`（加密存储，不进仓库）。`.dev.vars` 仅供本地联调。

### 4.3 注册 webhook（一次性，关键）

浏览器打开或 curl（用你 deploy 输出的真实子域）：

```bash
curl https://watch-ai-qqbot.<你的子域>.workers.dev/setup
```

这会用本次请求的公网地址自动 `setWebhook` 指向本 Worker 的 `/webhook`，并回显 `getWebhookInfo`——
看到 `"url":"https://.../webhook"` 且无 `last_error_message` 即成功。

### 4.4 验证已上线

```bash
curl https://watch-ai-qqbot.<你的子域>.workers.dev/healthz
# → {"ok":true,"build":"telegram-20261025-v16","channel":"telegram"}
```

实时日志：`npx wrangler tail`（消息/语音转写/LLM/回复全在这里）。

## Step 5 Apple Watch 上发第一单

1. Watch 安装「Telegram」App（iPhone Watch App → 可用应用 → Telegram）
2. 手表 Telegram 里找到你的 Bot，两种输入方式：
   - **听写（推荐，零配置）**：点麦克风听写 → 转成文字发送
   - **语音条（需 Step 3）**：按住麦克风直接发语音
   > 听写示范：「用 gemini 帮我写一个 python 快速排序，带类型注解」
3. 约 5~30 秒收到回复（代码 + 说明），手表震动提醒

**第一条消息发出后，去 `wrangler tail` 日志里找 `chat=<数字>`——那就是你的 chat_id**，下一步加固要用。

## Step 6 加固（5 分钟，建议做）

1. **填白名单**：把上一步日志里的 `chat_id` 填进 `wrangler.toml` 的 `ALLOWED_USERS`，重新 `npx wrangler deploy`——否则任何给 Bot 发消息的人都能支使机器人烧你的 key
2. 按需调 `DAILY_CALL_BUDGET`（日调用上限）/ `RATE_LIMIT_PER_MIN`（分钟级限流）
3. Gemini 侧在 AI Studio 设消费告警

## 本地联调（不依赖 Telegram）

```bash
cd workers-impl
npx wrangler dev                  # 本地跑 Worker + DO，读 .dev.vars
curl http://localhost:8787/healthz
# 纯逻辑单测（意图解析/分段/Update 提取，不依赖网络）：
npm test                          # 79 项断言
# 主动推一条文本测试回包：
curl "http://localhost:8787/send?text=hi&chat_id=<你的chat_id>"
```

## 排障表

| 现象 | 原因 | 处理 |
|---|---|---|
| 发消息完全没反应 | webhook 没注册成功 | 重新 `curl .../setup`，看返回的 `getWebhookInfo.url` 是否正确、有无 `last_error_message` |
| 日志出现 `非白名单 chat=...，忽略` | 命中白名单 | 把该 chat_id 加进 `ALLOWED_USERS`，或清空白名单 |
| 日志 `403 forbidden` | `TELEGRAM_WEBHOOK_SECRET` 与 setWebhook 时不一致 | 重新 setup，或删掉该 secret |
| 能收但不回 | Gemini key 没配/配额耗尽 | 日志里 `[agent]` 有报错；`providers.json` 里没 key 的厂商自动禁用 |
| 语音没转写 | 未配 `STT_BASE_URL/STT_API_KEY` | 配 Groq Whisper（Step 3）；或让用户发文字 |
| 回复报「所有厂商均失败」 | 所有厂商 key 无效/配额耗尽 | 日志 `[agent]` 详细报错；换 key 或配 fallback 厂商 |
| 手表收不到推送 | 手表 Telegram 通知权限 / 手机登录状态 | Watch App → 通知 → Telegram 允许通知 |
| 想跑 Claude Code / 本地 Whisper | Workers 不能跑任意进程 | 当前仓库未内置 VPS 执行体；需要时自建（意图路由/厂商 fallback 设计参照 `workers-impl/src/router/`） |
