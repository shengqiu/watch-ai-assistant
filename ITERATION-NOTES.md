# Watch AI 编程助手 — 部署与迭代纪要

> Apple Watch 语音 → 云端 AI 编程助手（Telegram 通道 / Cloudflare Workers 免费档）
> 纪要截至 2026-10-26，仓库 BUILD v16；线上实际部署版本以 CF Dashboard / `curl /healthz` 为准。

## 架构一句话

Apple Watch 发语音/文字 → Telegram → webhook POST 到 Cloudflare Worker → 唤醒 Durable Object（SQLite 存会话/限流/额度）→ 语音走 STT 转写 → 意图解析（点名厂商/任务类型/思考档位）→ Gemini 多模型路由（失败自动降级）→ MarkdownV2 渲染分段回包。

## 踩坑记录（按解决顺序）

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 回复要等 68~104s | `gemini-3.8-flash` 是思考模型，默认思考预算拉满；传 `minimal` 又被拒（3.7/3.8 已移除该档，HTTP 400） | 闲聊主路直取 `gemini-3.5-flash-lite`（不思考，实测 ~0.6s）；`clampEffort` 把落不到 Flash 系的 minimal 钳成 low；模型级降级 + 分层超时（high 120s / 其余 45s） |
| 2 | 代码显示为纯文本 | LLM 输出 **4 空格缩进代码块**，而 Telegram MarkdownV2 只认 ``` 围栏 | `mdToV2` 前置 `liftIndentedCode`：空行后连续 ≥2 行缩进 → 提升为围栏（带列表/引用/单行/段内缩进误判保护）；系统提示同步强制围栏输出 |
| 3 | 正文 Markdown 不渲染 | v4 安全策略是「正文全量转义」，`**粗体**` 等全变字面量 | v9 富文本映射：`**x**`→`*x*`、`*x*`→`_x_`、`~~x~~`→`~x~`、`## 标题`→粗体、`[文字](url)`→链接；内容首尾空格约束防 `2 * 3` 数学式误判；snake_case 安全 |
| 4 | 转义被 Telegram 拒收 | MarkdownV2 有 18 个特殊字符，不转义必 400 | `escapeV2` 全量转义 + 代码块内只转义 `` ` `` 和 `\` + 400 自动降级纯文本重发 |

## 版本时间线（均为 UTC）

| 版本 | 版本 ID | 关键改动 |
|---|---|---|
| v1 | 3e97ca76 | 首个可用版（Telegram 通道） |
| v2 | 37bbf70b | 思考档位控制 + 模型降级 + 分层超时 |
| v3 | c8dfcd23 | 闲聊主路 flash-lite；降级不再静默（打 `[router]` 警告） |
| v4 | b90eae63 | MarkdownV2 渲染（代码块高亮）+ 400 降级 + chunkText 代码块感知 |
| v7 | 8e4f91ca | 缩进代码块兜底提升 + 系统提示强制围栏 |
| v8 | 4ba6b464 | 「诊断」命令：回显模型原文格式（本次定位主力工具） |
| v9 | ec208c43 | 正文富文本：粗体/斜体/删除线/标题/链接 |

## 已知平台限制（非缺陷）

- 列表（`-`/`1.`）、引用（`>`）、表格在 MarkdownV2 无对应实体 → 字面显示
- Apple Watch 端 Telegram 基本只渲染纯文本 → 代码/富文本效果请用手机端查看
- 沙箱 DNS 污染 `*.workers.dev` 和 CF 日志服务 → 沙箱内无法 curl Worker URL、无法 `wrangler tail`；验证靠 CF API（`deployments list` / 拉取 script 源码）

## 运维备忘

- **待办：删除 Cloudflare API Token**（Dashboard → My Profile → API Tokens）。部署已全部完成，不再需要
- 部署命令：`CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy`
- 测试：`npm test`（当前 79/79）
- 白名单：`ALLOWED_USERS`（wrangler.toml，填你自己的 Telegram chat_id；首发一条消息后从 `wrangler tail` 日志可见）
- 调试入口：Bot 内发「诊断」看模型原文格式；`/healthz` 看 build 号

## 代码位置

`/workspace/watch-ai-arch/workers-impl/`（生产代码）
- `src/telegram/markdown.ts` — 全部渲染逻辑（转义/缩进提升/富文本/围栏）
- `src/router/providers.ts` — 多厂商路由 + 思考档位钳制
- `src/bot-do.ts` — DO 心脏（消息流水线 + 诊断命令）
- `test/logic.test.mjs` — 79 个纯逻辑用例

## v13：公开到 GitHub（2026-10-25）

- 仓库：https://github.com/shengqiu/watch-ai-assistant （public，54 文件）
- 脱敏：chat_id/Account ID/全部 token 引用清零，示例文件只留占位符；推送前全库扫描零命中
- 通道备注：沙箱到 `github.com` 主站极端不可用（12s+ 超时），但 `api.github.com` 0.26s 正常
  → 走 GitHub API 四步推送（blob → tree → commit → ref），脚本 `api_push.py`
- 踩坑：① 空仓库连 `POST /git/blobs` 都返 409「Git Repository is empty」→ 先用 Contents API
  播种一个 `.gitkeep` 让仓库非空；② `GET /git/refs` 空仓库返 409 而非 404；③ 本机 git 的
  `ls-files -s` 输出是 `<mode> <sha> <stage>`（无 type 字段），别按文档里的 `<mode> <type> <sha>` 解析

## v14：外部地址全配置化（2026-10-25）

- 动因：公开仓库审查要求——所有写死的网址改为配置形式，换代理/端点不改代码
- workers-impl：新增 `src/config.ts` 集中解析端点（TELEGRAM_API_BASE，默认官方地址）；
  TelegramClient 改为构造注入地址，删除客户端内全部硬编码 URL
- 探针：wa-probe / gemini-probe 的探测目标移入各自 `targets.json`（沿用 providers.json 模式）
- reference-impl：微信 API 基地 (`WX_API_BASE` / `WX_QY_API_BASE`) 入 config.py，
  客户端改 `base_url` 参数注入，factory (build_client) 从 settings 传值
  （该组件已于 v15 整体移除，见下）
- 保持零配置可用：所有变量不配 = 官方默认值；厂商地址本就在 providers.json，STT 本就在 STT_BASE_URL
- 保留例外：`src/index.ts` 里 `http://do/...` 是 Worker→Durable Object 的内部寻址，
  不是外部服务端点，无配置化必要

## v15：移除微信路线（2026-10-26）

- 动因：用户明确不需要微信内容，公开仓库不应含微信 API 相关代码与文档
- 删除 `reference-impl/`（20 文件）——该目录彻头彻尾是微信自托管实现
  （mp/qywx 双通道、加解密、媒体、客服消息），顺带清掉误跟踪的 2 个 .pyc
- 删除 `docs/ARCHITECTURE.md`——早期设计文档，微信章节删后大半成过期内容；
  现行架构以 `workers-impl/README.md` + 本文档为准
- `docs/DECISIONS.md`：删 ADR-1/ADR-2（微信通道选型、微信 ASR），编号保留不重排；
  清理 ADR-3/4/5/7/8/9/11 中的微信与 reference-impl 表述（含 ADR-8 里一段误粘贴的
  ADR-7 结论重复块）
- `docs/HOSTING.md` / `docs/DEPLOY.md` / `README.md` / `workers-impl/README.md` /
  `diagram.html` / `CHANNEL-RESEARCH.md`：手术式清理微信/reference-impl 表述
  （其中 HOSTING.md / diagram.html 已于 v16 整体删除，见下）
- `src/bot-do.ts`：注释里「微信式 echostr」改中性表述（echostr 回显验证是平台通用协议）；
  BUILD → v15。**功能逻辑零变化**（94/94 测试 + tsc 通过）

## v16：移除 QQ 路线（2026-10-26）

- 动因：用户明确不需要 QQ 内容，公开仓库只保留 Telegram 单通道
- 删除 `workers-impl/src/qq/`（client/update/verify 三文件）——QQ WebHook 通道全量实现
- 删除 `docs/HOSTING.md`（早期长连接时代选址文档）与 `diagram.html`（早期架构图），
  同 v15 删 ARCHITECTURE.md 的先例
- `src/bot-do.ts`：删 QQ imports/字段/构造/路由/整段 QQ 通道（webhook/debug/流水线/回包）；
  diagnose 去掉 qq 通道状态行；BUILD 注释删 v10~v12 记录，BUILD → v16
- `src/env.ts` / `src/config.ts`：删全部 QQ_* 变量与 qq 端点（仅留 TELEGRAM_API_BASE）
- `src/index.ts`：删 `/qq/webhook`、`/qq/debug` 路由；`/setup` 改用 endpoints(env) 注入
- `wrangler.toml`：删 QQ 端点注释、迁移注释中性化（QQBotDO 迁移条目功能性保留）
- `package.json` / `package-lock.json`：改名 watch-ai-qqbot → watch-ai（worker name 不变，
  维持既有 workers.dev 地址）
- 测试：删 QQ import 与 15 个 QQ 事件提取用例，94 → 79 项
- `docs/DECISIONS.md`：删 ADR-7/ADR-8（QQ 通道选型与实现），编号保留不重排；
  ADR-9/9.1 重写去 QQ 协议细节（保留 CF 选型与 webhook 优先决策）；ADR-11 改为中性的
  Telegram 选型记录
- 文档手术：DEPLOY.md 删文末「QQ 备选」节；根 README / workers-impl README /
  CHANNEL-RESEARCH.md / 本文档同步清理
- 保留例外：wrangler.toml `name = "watch-ai-qqbot"`（维持既有 workers.dev 地址）与
  SQLite 迁移条目 QQBotDO（功能性）；各文档 URL 示例沿用真实部署名
- **功能逻辑零变化**（79/79 测试 + tsc 通过 + dry-run 通过）

## v16.1：git 历史邮箱脱敏 + 探针 URL 中性化（2026-10-26）

- 动因：公开仓库安全审计——种子提交（Contents API 播种 .gitkeep 时未指定 committer）
  的 author/committer 落入账号真实邮箱，`git clone` 后 `git log` 可见
- 修复（不重建仓库，用户要求）：经 Git Data API 建无父 root commit
  （author/committer 显式 noreply）→ force 更新 main；clone/网页视角历史
  现为单一全 noreply 提交。残留：旧提交变 unreachable 对象，SHA 直链在
  GitHub GC 前仍可访问——彻底清除需用户提交 Support GC 请求（模板见会话记录）
- 探针文档（CHANNEL-RESEARCH.md / wa-probe / gemini-probe）中的真实 CF 子域
  改为 `<你的子域>` 占位符，与仓库其他文档惯例一致（子域字面量不再出现在任何文件）
- 内容零功能变化；密钥/Account ID/chat_id 等此前已脱敏项复扫仍为 0

## v16.2：部署文档准确性修正（2026-10-26）

- 动因：用户核对部署文档，发现与已上线 v16 不符的过期数值
- 修正 `docs/DEPLOY.md` 与 `workers-impl/README.md` 的 `/healthz` 示例
  `build` 字段（`...-v1` / `...-v4` → `telegram-20261025-v16`）
- 根 `README.md` 实现状态表「实际开通上线」🔄 进行中 → ✅ 已完成
  （v16 已部署，用户已在 Telegram 实测成功）
- 核对 `src/router/` 目录（intent.ts / providers.ts）确实存在，
  两份 README 文件地图对其的引用无误，无需修改
- 内容零功能变化；改动仅限文档
