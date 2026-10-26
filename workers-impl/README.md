# watch-ai（Cloudflare Workers 主实现）

Apple Watch 语音 → Telegram 机器人 → 按需选厂商（默认 Gemini）→ 编程问答，全链路跑在
**Cloudflare Workers 免费档**上：不买服务器、不绑信用卡、零运维、零备案，基础设施成本 ¥0。

## 架构（单 Worker + 单例 Durable Object，事件驱动）

```
Apple Watch (Telegram 手表版, 按住说话)
   │ 语音消息 (OGG/Opus) 或文字
   ▼
Telegram 服务器 ──webhook POST──▶ ┌──────────── Worker (src/index.ts) ────────────┐
                                   │  /webhook → 转发 DO                          │
                                   │  ┌────────── Durable Object "singleton" ─────┐ │
                                   │  │  (src/bot-do.ts)                          │ │
                                   │  │  流水线：去重→白名单→限流→日额度           │ │
                                   │  │    →文本/语音(ASR)→意图解析→LLM 路由       │ │
                                   │  │    →分段回包；状态全落 DO SQLite           │ │
                                   │  └───────────────────────────────────────────┘ │
                                   └───────────────────────────────────────────────┘
   │ sendMessage / getFile / 下载语音（出站 HTTPS，全球可达）
   ▼
Gemini（默认）/ DeepSeek / GPT / 通义 / 智谱 / Kimi —— 统一 OpenAI 兼容 /chat/completions
   ▲
   └── 语音转写：Groq Whisper（免费档）/ 任意 OpenAI 兼容 STT 端点
```

**为什么 Telegram + Workers 是绝配**：无常驻连接、不计 DO duration；Telegram 主动推事件
（全球可达，无备案、无 Ed25519 签名、无意图配置）；免费档 100k 请求/天对个人语音助手绰绰有余。

## 快速开始（10 分钟）

### 1. 前置（都不花钱）

| 步骤 | 去哪 | 拿什么 |
|---|---|---|
| Telegram Bot | 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 起名 | `BOT_TOKEN`（形如 `123456:ABC-DEF...`，**只显示一次**） |
| Gemini key | [aistudio.google.com](https://aistudio.google.com) → Get API key | `GEMINI_API_KEY`（免费档够个人用） |
| 语音转写（可选） | [console.groq.com](https://console.groq.com) 申请 key | `STT_API_KEY`——**仅「按住发的语音条」才需要；用手表听写输入则免配，见 Step 4** |
| Cloudflare | [dash.cloudflare.com](https://dash.cloudflare.com) 注册 | **免费档不用绑卡** |

> 提醒：Telegram 在中国大陆需代理/VPN 才能使用（手机与手表都要能连）。

### 2. 部署

```bash
cd workers-impl
npm install

npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN   # 粘贴 BotFather 给的 token
npx wrangler secret put GEMINI_API_KEY
# （可选）只有"按住发的语音条"才需要转写；用手表听写则跳过这三行
npx wrangler secret put STT_BASE_URL         # https://api.groq.com/openai/v1
npx wrangler secret put STT_API_KEY
# （可选）webhook 防伪密钥，自定义随机串：
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

npx wrangler deploy
```

### 3. 注册 webhook（一次性）

部署后浏览器打开或 curl：

```bash
curl https://watch-ai-qqbot.<你的子域>.workers.dev/setup
```

这会用本次请求的公网地址自动 `setWebhook` 指向本 Worker 的 `/webhook`，并回显
`getWebhookInfo`（`url` 正确、`pending_update_count` 正常即成功）。

验证 Worker 活着：

```bash
curl https://watch-ai-qqbot.<你的子域>.workers.dev/healthz
# → {"ok":true,"build":"telegram-20261025-v16","channel":"telegram"}
```

看实时日志：`npx wrangler tail`。

### 4. 手表发第一单

Telegram 里找到你的 Bot 发消息，或 Apple Watch 装 Telegram 手表版 → 与 Bot 私聊。手表上两种输入方式：

- **听写（推荐，零配置）**：点麦克风**听写**，Watch 把语音转成文字发出来，Bot 收到文字直接处理——**不需要任何 ASR 配置**
- **语音条（可选）**：按住麦克风直接发的语音消息，Bot 下载后转写——**需要配 Groq Whisper**

> 听写示范：「用 gemini 帮我写个快速排序」

**第一条消息发出后，去 `wrangler tail` 日志里找 `chat=<数字>`——那就是你的 chat_id**，填进
`ALLOWED_USERS` 收紧白名单（见下文安全）。

## 说话方式（意图路由）

| 你说 | 行为 |
|---|---|
| 「用 gemini 写个爬虫」 | 指定厂商 Gemini，default 档（gemini-3.8-flash，思考 effort=low） |
| 「这个问题很复杂，用 pro 档」 | Gemini flagship 档（gemini-3.1-pro-preview，effort=high，仅付费 key） |
| 「用 gemini flash，快点」 | fast 档（gemini-3.5-flash-lite，默认不思考，亚秒级） |
| 「你好」「今天天气怎么样」 | 闲聊主路直取 flash-lite（gemini-3.5-flash-lite，不思考，实测 ~0.6s） |
| 「先用 deepseek，不行再用 gemini」 | fallback 链，deepseek 失败自动切 gemini |
| 「让 kimi 看看这段报错」 | 切 Kimi（需配 key） |
| 什么都没说 | 走默认策略（`DEFAULT_CODING_PROVIDER` / `DEFAULT_CHAT_PROVIDER`） |

### 为什么不会等到天荒地老（延迟设计）

Gemini 3 系是**思考模型且思考无法关闭**（Google 官方文档明确），默认思考预算很高——
实测 `gemini-3.8-flash` 不传参数时要 **68~104 秒**才回话，手表上完全没法用。四道防线：

1. **按场景选主模型**：闲聊/简单问答**主路直取 `gemini-3.5-flash-lite`**（默认不思考，
   实测 **~0.6s**）；写代码走 `gemini-3.8-flash`；明确说「pro 档」才上旗舰；
2. **思考档位控制**：按意图下发 `reasoning_effort`（代码 `low` / 旗舰 `high`），
   把思考 token 从默认的万级压到千级——延迟从分钟级回到秒级的关键；
3. **档位钳制**：`minimal` 档在 Gemini 3.7/3.8 Flash 上**已被移除**（传了直接 HTTP 400，
   官方文档映射表滞后未更新，2026-10-25 实测）——代码自动把落到这些模型的 minimal
   兜底成 `low`，Flash-Lite 才收 minimal；
4. **模型级降级 + 分层超时**：主模型失败（非旗舰 45s）自动降级 fast 模型，绝不空手而归；
   降级会打 `[router]` 警告日志，不静默；旗舰档放宽到 120s。

## 免费档额度账本（webhook 模式）

| 资源 | 免费档限额 | 本项目用量 | 余量 |
|---|---|---|---|
| 请求数 | 100,000/天 | ≈几百/天（纯消息驱动，无常驻） | ~99% |
| DO duration | 13,000 GB-s/天 | 接近 0（事毕即休眠） | ~100% |
| DO SQLite | 5 GB | KB 级 | 99% |
| 模型 API | Gemini AI Studio 免费档 | 个人轻度使用通常 ¥0 | — |

> webhook 事件驱动模式下 DO「按需唤醒、处理完即休眠」，duration 成本近似为零——
> 这正是相比长连接方案的巨大优势。

## 运维手册

### 外部服务地址配置（全部可配，默认官方地址）

所有外部端点集中在 `src/config.ts` 解析，**不改代码**即可覆盖（换代理、换区域端点、内网联调）：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Telegram Bot API 根（含文件下载） |

模型厂商地址走 `providers.json` 的 `base_url`，语音识别走 `STT_BASE_URL`——同为配置，无需改代码。

### 常用命令

```bash
npx wrangler tail                              # 实时日志（消息/回复/报错）
npx wrangler deploy                            # 重新部署
npx wrangler secret put TELEGRAM_BOT_TOKEN     # 轮换密钥（不进仓库）
npx wrangler secret list                       # 查看已注入的密钥名
```

### 排障

| 现象 | 原因与处理 |
|---|---|
| 发消息完全没反应 | webhook 没注册成功 → 重新 `curl .../setup`，看返回的 `getWebhookInfo.url` 是否正确 |
| 日志出现 `非白名单 chat=...，忽略` | 命中白名单；把该 chat_id 加进 `ALLOWED_USERS`，或清空白名单 |
| 能收但不回 | Gemini key 没配/配额耗尽 → 日志里 `[agent]` 有报错；`providers.json` 里没 key 的厂商自动禁用 |
| 回复要等几十秒 | 思考模型默认档太慢 → 已默认压档（闲聊 minimal/代码 low）；日志 `via` 行看实际耗时与模型，仍慢就说「flash 快点」 |
| 代码显示成原始 ``` 符号 | MarkdownV2 渲染失败已自动降级纯文本 → 看日志有无 `[tg] MarkdownV2 被拒收` 警告；正常不该出现 |
| 语音没转写 | 未配 `STT_BASE_URL/STT_API_KEY` → 配 Groq Whisper；或让用户发文字 |
| 403 forbidden | `TELEGRAM_WEBHOOK_SECRET` 与 setWebhook 时不一致 → 重新 setup |
| 想跑 Claude Code / 本地 Whisper | Workers 不能跑任意进程 → 需自建 VPS 执行体（仓库未内置） |

### 安全默认值

- `ALLOWED_USERS`：**生产必填**（你的 `chat_id`，首发一条消息后从 `wrangler tail` 日志复制），否则任何人都能支使你的机器人烧 key
- `TELEGRAM_WEBHOOK_SECRET`：建议设置，防伪请求打到 `/webhook`
- `DAILY_CALL_BUDGET=200`：日调用上限，防失控
- `RATE_LIMIT_PER_MIN=20`：每分钟上限
- 密钥全部走 `wrangler secret put`，不进仓库

## 文件地图

```
src/index.ts            Worker 入口（路由转发 + /setup 注册 webhook）
src/config.ts           外部服务地址集中解析（Telegram 端点，默认官方地址、环境变量可覆盖）
src/bot-do.ts           ★ Durable Object：消息流水线/意图路由/回包/状态存储
src/telegram/client.ts  Telegram Bot API 客户端（setWebhook/sendMessage/getFile/下载）
src/telegram/update.ts  Update → Incoming 提取（chat_id/text/voice）
src/telegram/types.ts   Telegram 类型（Update/Message/Voice/File）
src/telegram/markdown.ts LLM markdown → MarkdownV2 安全转换（代码块渲染 + 防 400）
src/router/intent.ts    意图解析（厂商别名 / 档位 / fallback 链）
src/router/providers.ts 厂商配置加载 + 统一 chat/chatChain（fallback）
src/asr.ts              语音转写（OpenAI 兼容 STT）+ 长文本分段
src/env.ts              环境绑定类型
providers.json          厂商配置（模型档位/base_url/headers；${ENV} 占位）
wrangler.toml           DO 绑定 / SQLite 迁移 / vars
test/logic.test.mjs     纯逻辑单测（意图/分段/Update 提取）
```

## 已知边界（诚实清单）

- **不能跑任意进程**：无本地 Whisper（ASR 走 API）、无 Claude Code CLI（Agent 只有 LLM 直出模式）——需要时加一台 VPS 自建执行体
- **Telegram 在中国大陆被墙**：手机与手表都需要代理/VPN 才能用
- **Gemini 3 系思考无法完全关闭**（官方限制），且 `minimal` 档在 3.7/3.8 Flash 上已被移除（传了直接 400，代码自动钳制为 `low`）；闲聊主路已直取不思考的 Flash-Lite（实测 ~3s），重活说「pro 档」主动等高思考
