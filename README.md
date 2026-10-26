# watch-ai：Apple Watch 语音 → 云端 AI 编程助手

在 Apple Watch 的 Telegram 里对「一个助手」按住说一段话，云端自动完成
**听写 → 理解意图 → 按需选择 AI 厂商 → 产出代码/答案 → 回传手表**的完整闭环。

全流程 **¥0、不需要信用卡、不需要域名/备案/公网入口**。

> ⚠️ Telegram 在中国大陆被墙，手机与手表需代理/VPN 才能使用。

---

## 当前架构快照（2026-10-25 定稿）

| 决策点 | 结论 | 依据 |
|---|---|---|
| 终端通道 | **Telegram 官方 Bot**（Watch Telegram 手表版语音输入；Webhook 模式——平台推事件到 `/webhook`；免审核、免备案、免签名） | ADR-11 |
| 计算平台 | **Cloudflare Workers + Durable Objects**（事件驱动、无常驻连接、免费档 100k 请求/天、SQLite 5GB，免卡） | ADR-9 |
| 模型厂商 | **Google Gemini**（`gemini-3.8-flash` 默认 / `gemini-3.1-pro` 旗舰 / `gemini-3.1-flash-lite` 快速，OpenAI 兼容端点） | ADR-10 |
| 路由 | 自研薄路由：自然语言解析厂商/档位 → fallback 链（gemini → deepseek → qwen → zhipu → moonshot） | ADR-3 |
| 执行体 | 默认 LLM 直出（Workers 无子进程能力；CLI 执行体需自建 VPS，仓库未内置） | ADR-4 |

> 一条语音的旅程：Watch Telegram 说话 → 语音(OGG)推到 Worker → 下载后送 Groq Whisper 转写 → DO 里去重/白名单/限流 → 意图解析 → Gemini 生成 → `sendMessage` 分段回包 → 手表收到。

> 为什么选 Telegram 通道：官方 Bot API 成熟稳定，webhook 模式免审核、免备案、免签名，平台主动推事件（全球可达）。详见 ADR-11。

## 仓库导览

```
watch-ai-arch/
├── workers-impl/          ★ 主实现（Cloudflare Workers + Telegram，可直接部署）
│   ├── src/bot-do.ts          Durable Object：消息流水线 + 意图路由 + 回包 + 状态存储
│   ├── src/telegram/          Telegram Bot API 客户端 / Update 提取 / 类型
│   ├── src/router/            意图解析 + 厂商路由 + fallback 链
│   ├── src/asr.ts             语音转写（OpenAI 兼容 STT）+ 长文本分段
│   ├── providers.json         厂商清单（gemini 默认启用，anthropic 默认关闭）
│   ├── wrangler.toml          DO 绑定 / SQLite 迁移 / vars
│   └── test/logic.test.mjs    79 项纯逻辑测试（tsc 通过、dry-run 通过）
└── docs/
    ├── DECISIONS.md       ADR-3~11 选型决策与理由（ADR-1/2 微信路线、ADR-7/8 QQ 路线已移除）
    └── DEPLOY.md          ★ 从零部署手册（30 分钟跑通）
```

## 快速开始（4 步，约 30 分钟）

```bash
# 1. 拿凭证：Telegram Bot（@BotFather /newbot 拿 token）
#    + Gemini key（aistudio.google.com，免费档）
#    + （推荐）Groq Whisper key 做语音转写——详见 docs/DEPLOY.md Step 1-3

# 2. 部署（全程免卡；secret 只需注入一次）
cd workers-impl && npm install
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy

# 3. 注册 webhook（一次性）
curl https://watch-ai-qqbot.<你的子域>.workers.dev/setup

# 4. 验证
curl https://watch-ai-qqbot.<你的子域>.workers.dev/healthz
# → {"ok":true,"channel":"telegram",...}  之后 Watch Telegram 直接对 Bot 说话即可
```

完整排障表、白名单加固、本地联调见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

## 实现状态

| 模块 | 状态 |
|---|---|
| Telegram Bot API 客户端（setWebhook/sendMessage/getFile/下载语音） | ✅ 完成 |
| 消息流水线（去重/白名单/限流/日额度/分段回包） | ✅ 完成 |
| 意图解析 + Gemini 路由 + fallback 链 | ✅ 完成，79/79 测试通过 |
| Cloudflare 部署配置（DO + SQLite + webhook） | ✅ 完成，`deploy --dry-run` 通过 |
| 从零部署文档 | ✅ 完成 |
| 实际开通上线（需要用户本人的 Telegram/Gemini/CF 账号） | ✅ 已完成（v16 已部署，BUILD `telegram-20261025-v16`） |
