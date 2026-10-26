# 技术选型决策记录（ADR）

> 每条决策记录：背景 → 选项对比 → 结论 → 理由。日期 2026-10-24。
>
> 注：ADR-1 / ADR-2（微信通道选型、微信 ASR）随微信路线移除已于 2026-10-26 删除；
> ADR-7 / ADR-8（QQ 通道选型与实现）随 QQ 路线移除已于 2026-10-26 删除；
> ADR 编号保留不重排，避免既有引用失效。

## ADR-3 LLM 路由：MVP 自研薄路由，按需上前置 new-api / LiteLLM

| 方案 | Stars/活跃度 | 强项 | 弱项 |
|---|---|---|---|
| new-api | 4.2 万+，活跃 | Web 后台、多渠道 key 分发、额度计费、中文生态 | AGPL-3.0（改造后对外服务需开源） |
| LiteLLM | 5.4 万+，活跃 | 100+ 提供商、Python SDK 一体、负载均衡/fallback/成本追踪 | 后台偏轻，Proxy 模式配置曲线陡 |
| one-api | 3.6 万，停更 | 经典省心 | 2026-01 后无提交，新模型要自己补 |
| Portkey | 1.2 万，活跃 | 转发快、50+ 护栏 | 多用户分发弱 |
| **自研薄路由** | — | 零依赖、配置驱动、完全可控 | 无后台/计费，自己维护 |

**结论**：MVP 用自研薄路由（`workers-impl/src/router/`，`providers.json` 配置驱动，OpenAI 兼容客户端直连各家）；出现"管多个 key / 给多人分发 / 看消耗"需求时，前置 new-api（自用无 AGPL 顾虑）或 LiteLLM。
**理由**：三方案对外都是 OpenAI 兼容 `/chat/completions`，后置接入无痛，避免过早引入运维负担。

## ADR-4 编程执行体：LLM 直出为默认，Codex CLI / Claude Code CLI 为进阶

**结论**（2026-10-24 更新）：默认单轮/多轮 LLM 生成（带系统提示与仓库上下文）；复杂任务切 CLI 执行体子进程模式，工作目录锁定仓库——**Codex CLI 与 Claude Code CLI 二选一，接口同构**（需 VPS 自托管，当前仓库未内置）。
**理由**：LLM 直出覆盖 80% 手表场景（短代码、解释、重构片段）；CLI 执行体处理多文件改动且迭代闭环。OpenHands 留作 V2（容器资源需求高）。
**Codex CLI 落地参数**（2026-10 官方文档坐实）：`npm i -g @openai/codex`；非交互模式 `codex exec "<prompt>"`——最终消息走 stdout、进度走 stderr、零交互审批；改文件需 `--sandbox workspace-write`（默认只读；`--full-auto` 已是废弃兼容 flag）；非 Git 工作区必须 `--skip-git-repo-check` 否则退出 1；`-C <dir>` 指定工作目录；进阶接口有 `--json`（JSONL 事件流）、`-o`（最终消息落盘）、`--output-schema`（结构化输出）、`codex exec resume --last`（多阶段管道）。headless 认证 `codex login --device-auth`，CI 用 `CODEX_API_KEY`。
**边界（重要）**：CLI 执行体依赖子进程，**只能在 VPS/Docker 路径自建**；Cloudflare Workers 是 V8 isolate 无子进程能力，Workers 路径（`workers-impl/`，当前主实现）上执行体恒为 LLM 直出。
**计费差异**：Codex CLI 可用 ChatGPT 订阅（Plus/Pro 等，exec 计入计划额度）或 API key 计量；Claude Code CLI 需 Anthropic API key 或 Claude 订阅。按你已有的订阅选，避免双重付费。
**安全**：生成代码一律沙箱执行；破坏性操作回 IM 二次确认。

## ADR-5 部署：单机 Docker Compose 起步，国内云/海外 VPS 二选一

**结论**：个人自用单机足够（2C4G）。国内主体+国内模型 → 国内轻量云（域名需 ICP 备案）；重度 Claude/GPT → 海外 VPS（免备案，回调延迟可接受）。
**理由**：公网回调只要求公网 HTTPS，无地域限制；先跑起来再谈高可用。

## ADR-6 会话与状态：Redis（会话/去重/限流），Postgres 后置

**结论**：MVP 进程内内存实现（接口与 Redis 适配器同构），上生产换 Redis；任务记录/审计日志先落文件，V2 再上 Postgres。
**理由**：个人自用量级下内存足够，但 `SessionStore` 抽象保证迁移只换实现。

## ADR-9 计算平台终版：Cloudflare Workers + Durable Objects（2026-10-24）

**背景**：ADR-5 定的是「单机 Docker Compose + VPS」。用户要求先敲定云计算产品再动代码，并对「Oracle 之外的免费选项」做了全量调研（GCP e2-micro / Azure 12 个月 / CF Workers / HF Spaces / Render / Fly / Railway / Deno Deploy / 腾讯云试用 / 家里常开设备）。

**调研关键事实**：
- **Render Free 出局**：免费档无 background worker，且 15 分钟无请求即休眠——长连接 bot 永远算「空闲」。Fly.io / Railway / Heroku 免费档均已终结；HF Spaces 的 Docker/Gradio 自 2026-07 起需 PRO $9/月。
- **永久免费的 VPS 只剩 Oracle（2C12G，注册要国际信用卡+抢容量）与 GCP e2-micro（仅美国 3 区、1GB）**；Azure 是 12 个月过渡。
- **Cloudflare Workers 免费档**：10 万请求/天、13,000 GB-s/天、DO SQLite 5GB、**无需绑卡**；DO 事件驱动、按请求唤醒、事毕休眠，duration 成本近似为零——与「云端助手收事件→处理→回包」的形态天然匹配（事件接入模式见 ADR-9.1）。

**结论（用户已确认选 Cloudflare Workers）**：
1. 计算平台 = **Cloudflare Workers + Durable Objects**（`workers-impl/`，TypeScript，主实现）。
2. 状态（会话历史/去重/限流/日额度）全部落 DO SQLite；无常驻连接、无 cron 心跳依赖。
3. **失去的能力及对策**：本地 Whisper（无 Python/ffmpeg）→ OpenAI 兼容 STT API；Claude Code CLI（不能跑子进程）→ 仅 LLM 直出模式。
4. 成本：基础设施 ¥0（免卡），模型 API 按量。webhook 事件驱动下请求约几百/天（限额 10 万），DO duration 接近 0——免费档余量充足。
5. **自托管备选路径**（Oracle/Hetzner VPS）当前仓库未内置实现（Python 参考实现已于 2026-10-26 移除），需要时可按同一套意图路由/厂商 fallback 设计重建。

**理由**：¥0 + 免信用卡 + 零运维 + 边缘低延迟，且本架构「只需出站 HTTPS」的形态与 DO 休眠机制天然匹配；失去的「跑任意进程」能力有 API 级替代且不是 MVP 必需。
**代价**：相比 Python 方案整体改写为 TypeScript。

### ADR-9.1 事件接入模式修正：Webhook 优先（2026-10-24 晚间，实测后追加）

**背景**：ADR-9 初版按「长连接保活」设计（DO 常驻出站 WS + alarm 心跳）。实测验证后确认：聊天机器人的事件接入**默认 Webhook 模式**（平台主动 POST 推事件到开发者 HTTPS 端点），长连接只作备选。

**结论**：
1. 事件接入**默认 Webhook 模式**：Worker 收 `POST /webhook` → 解析事件 → 既有流水线（waitUntil 后台处理，立即 ACK）；回复走 REST 出站（CF 出口可达，已验证）。
2. **收益**：无常驻连接 → DO 按请求唤醒、不计 duration；无 alarm/cron 心跳依赖；代码路径更短；免费档 100k 请求/天对个人用量（日均几十条）绰绰有余。
3. 长连接客户端代码不作默认路径：CF Workers 的 fetch 原生不支持 `wss://`，且部分平台对出口 IP 有风控；其他部署环境（VPS/自托管）如需要可自行扩展。
4. ADR-9 初版「放哪台机器取决于长连接」的前提修正为：**平台选择不绑定连接形态，webhook 事件模式支撑 workers-impl 运行**。

## ADR-10 模型厂商主选：Google Gemini（2026-10-24）

**背景**：用户明确「不想用 Claude，要用 Google Gemini」。

**结论**：
1. 主厂商 = **Gemini**（`DEFAULT_CODING_PROVIDER=gemini`、`DEFAULT_CHAT_PROVIDER=gemini`）：default 档 `gemini-3.8-flash`、flagship 档 `gemini-3.1-pro`、fast 档 `gemini-3.1-flash-lite`。
2. 接入方式 = Gemini 官方 **OpenAI 兼容端点** `https://generativelanguage.googleapis.com/v1beta/openai/`（`Authorization: Bearer {GEMINI_API_KEY}`）——与其余厂商共用同一套 `/chat/completions` 路由代码，零额外适配。
3. **Claude 降级为可选**：`providers` 中 `anthropic` 置 `enabled: false`，填 key 后置 true 即恢复；意图别名表保留 `claude/anthropic/克劳德`。
4. 意图解析新增别名：`gemini / google / 谷歌 / gemini pro / gemini flash`；「pro 档」触发 flagship 档位。
5. 对架构的连带影响：Gemini 国内不可直连 → 计算侧必须出海 → 与 ADR-9（Cloudflare Workers）互相印证，国内 VPS 选项（腾讯云轻量）在 Gemini 为主的前提下不再适合。
6. 成本红利：AI Studio 免费档可覆盖个人轻度使用（~50 条/天），模型侧有机会 ¥0；超额按量计费。

**理由**：用户偏好；Gemini 3 档编程能力与 Claude/GPT 同档；OpenAI 兼容端点让「按需选厂商」的路由层零成本扩展；免费档进一步压低总成本。
**代价**：模型名随 Google 换代较快（`providers` 配置中集中管理，改名只改一处）；思考模型（3.x Pro）无法关闭思考，延迟高于 flash 档——fast 档用 flash-lite 规避。

## ADR-11 终端通道选型：Telegram 官方 Bot（2026-10-25）

**背景**：用户希望在常用 IM 里与云端助手对话。终端通道候选经逐一验证后收敛到 Telegram 官方 Bot。

**结论**：终端通道 = **Telegram 官方 Bot**。
1. 接入 = Webhook 模式：Telegram 主动 POST 事件到 `workers.dev/webhook`（**全球可达**，无备案、无 Ed25519 签名、无 intent 配置、无沙箱成员限制、免审核）；回复走 `sendMessage`，语音走 `getFile` + 下载。
2. 代码结构：`workers-impl/src/telegram/`（client/update/types）+ `src/bot-do.ts`（`AssistantDO`）；消息流水线（去重/白名单/限流/日额度/意图/路由/分段回包）与通道层解耦，换通道只换 client/update。wrangler 迁移 `v2 new_sqlite_classes=["AssistantDO"]`，cron 置空（无常驻连接需保活）。
3. 新增 `/setup` 端点：用请求的真实公网 origin 一次性 `setWebhook`。
4. 语音 ASR：走 OpenAI 兼容 STT 端点（默认推荐 Groq Whisper 免费档，`whisper-large-v3`）；不配则只能发文字。

**理由**：Telegram Bot API 是纯 HTTPS REST + webhook，与 Cloudflare Workers 事件驱动形态**天然绝配**——无备案、无签名、无审核、无意图配置的全部摩擦；@BotFather 30 秒出 token；无常驻连接、duration 成本≈0；Watch Telegram 手表版支持语音输入（听写/语音条均可）。
**代价**：**Telegram 在中国大陆被墙**——用户手机与 Apple Watch 需代理/VPN；语音需第三方 STT 转写（无平台内置免费 ASR）。
