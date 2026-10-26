/**
 * AssistantDO：整个机器人的心脏——一个 Durable Object（Telegram 通道版）。
 *
 * 职责：
 *   1. 收：Telegram 主动 webhook POST 到 /webhook（HTTPS 入站，全球可达，
 *      无备案、无签名、无 WebSocket），事件驱动、无常驻连接、不计 duration；
 *   2. 消息流水线：去重 → 白名单 → 限流 → 日额度 → 文本/语音(ASR) → 意图解析
 *      → LLM 路由（多厂商 fallback）→ 分段回包；
 *   3. 全部状态（会话历史、去重、限流、额度）落 DO SQLite。
 *
 * DO 仍是单例：SQLite 状态需要单点。webhook 模式下 DO 按请求唤醒、处理完即休眠，
 * duration 成本近似为零——免费档 100k 请求/天对个人语音助手绰绰有余。
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { endpoints } from "./config";
import { TelegramClient } from "./telegram/client";
import { extractIncoming, type Incoming } from "./telegram/update";
import type { TgUpdate } from "./telegram/types";
import { parseIntent, effortFor, type Intent } from "./router/intent";
import { chatChain, loadProviders, type ChatResult } from "./router/providers";
import { chunkText, transcribeBytes } from "./asr";
import { isVerified, isAnswerMatch, nextExpiry, CHALLENGE_TEXT, type VerifyState } from "./verify";

// 构建标记：每次改动后递增，方便确认线上跑的是不是最新包（curl /healthz 看 build 字段）。
// v2：Gemini 思考档位控制（reasoning_effort）+ 模型级降级 fallback + 分层超时。
//     背景：gemini-3.8-flash 默认思考预算拉满，手表端等到 68~104s 甚至超时。
// v3：闲聊主路直取 flash-lite（3.7/3.8 Flash 已移除 minimal 档，传了直接 400，
//     由 clampEffort 兜底降档 low）；主模型失败不再静默，打 [router] 警告日志。
// v4：回复以 Telegram MarkdownV2 渲染（代码块真正高亮）+ 400 自动降级纯文本；
//     chunkText 升级为代码块感知（不在围栏内切断）。
// v7：缩进代码块兜底——模型实测会输出 4 空格缩进代码块（Markdown 标准格式），
//     但 Telegram MarkdownV2 只认 ``` 围栏，导致代码渲染成普通文本。
//     现 mdToV2 先把缩进块提升为围栏（带列表/引用误判保护），
//     系统提示同步强制围栏输出，双管齐下。
// v8：新增「诊断」命令——回显最后一轮模型回复的原文格式（围栏/缩进可见化标记），
//     用于定位「高亮不生效」：区分模型输出格式问题 vs 发送降级 vs 客户端渲染。
// v9：正文富文本——markdown 行内语法转 MarkdownV2 实体（**粗体**→*粗体*、
//     *斜体*→_斜体_、~~删除线~~→~删除线~、## 标题→粗体、[文字](url)→链接）。
//     内容首尾空格约束防 "2 * 3" 数学式误判；V2 无实体的列表/引用/表格仍字面显示。
// v14：外部服务地址全部配置化——新增 src/config.ts 集中解析端点
//     （TELEGRAM_API_BASE，默认官方地址），客户端不再持有任何写死的 URL；
//     厂商地址走 providers.json。
// v15：移除微信路线——删除 reference-impl/（微信自托管实现）与 docs/ARCHITECTURE.md
//     （早期设计文档）；docs/ 各文档与 README 同步清理微信/reference-impl 表述。
//     端点配置化（v14）与全部功能逻辑不变。
// v17：安全加固——白名单拒绝时回报 chat_id（限流 1 条/分钟防刷屏），
//     TELEGRAM_WEBHOOK_SECRET 防伪校验保持既有逻辑不变。
// v16：移除 QQ 通道——删除 src/qq/、docs/HOSTING.md（早期选址文档）与 diagram.html
//     （早期架构图），env/config/路由/测试同步清理；仅保留 Telegram 单通道。
//     消息流水线、LLM 路由、状态存储逻辑不变。
const BUILD = "telegram-20261026-v19";

const SYSTEM_PROMPT = `你是一位资深软件工程师，通过用户的智能手表语音接收编程需求。
输出要求：
1. 先给结论或代码，再给必要解释——用户可能在手表上阅读，务必精炼
2. 代码必须放在 \`\`\` 围栏代码块中并标注语言（如 \`\`\`python），严禁使用 4 空格缩进代码块——Telegram 客户端不渲染缩进代码
3. 涉及多文件改动时，用清单列出「文件 → 改动点」
4. 信息不足时先说明你的假设，不要编造 API 或参数
5. 默认使用任务描述中指定的编程语言；未指定时用 Python`;

export class AssistantDO extends DurableObject<Env> {
  private readonly tg: TelegramClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 端点集中解析（默认官方地址，可用环境变量覆盖，见 src/config.ts）
    const ep = endpoints(env);
    this.tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN ?? "", ep.telegramApiBase);
    // SQLite 建表（幂等）；schema 版本标记避免每次唤醒都跑 DDL
    void this.ctx.storage.get("schema_v1").then((done) => {
      if (done) return;
      this.ctx.storage.sql.exec(SCHEMA_SQL);
      void this.ctx.storage.put("schema_v1", true);
    });
  }

  // ---------------------------------------------------------------- 入口

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/status":
          return Response.json(await this.status());
        case "/webhook":
          return await this.handleWebhook(request);
        case "/send": {
          // 调试用：主动推一条文本到指定 chat_id
          const text = url.searchParams.get("text") ?? "";
          const chatId = url.searchParams.get("chat_id") ?? "";
          if (!text || !chatId) return new Response("need ?text=&chat_id=", { status: 400 });
          await this.reply(chatId, text);
          return Response.json({ ok: true });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  // ---------------------------------------------------------------- Webhook

  /**
   * Telegram 事件推送入口：
   *   1. 可选校验 secret_token（X-Telegram-Bot-Api-Secret-Token，防伪请求）；
   *   2. 解析 Update，提取消息；
   *   3. 立即回 200（Telegram 要求快速应答），真正的处理放 waitUntil 后台跑。
   */
  private async handleWebhook(request: Request): Promise<Response> {
    const expected = this.env.TELEGRAM_WEBHOOK_SECRET;
    if (expected) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (got !== expected) return new Response("forbidden", { status: 403 });
    }

    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return new Response("bad json", { status: 400 });
    }

    const incoming = extractIncoming(update);
    if (incoming) {
      this.ctx.waitUntil(this.handleMessage(incoming).catch((e) => console.error("[tg]", e)));
    }
    return Response.json({ ok: true });
  }

  // ---------------------------------------------------------------- 消息处理

  private async handleMessage(m: Incoming): Promise<void> {
    // 1) 去重：Telegram 重试时可能重推同一 update_id
    const key = `u${m.updateId}`;
    if (await this.seenMsg(key)) return;
    await this.markSeen(key);

    // 2) 白名单（未配置 = 放开，仅建议开发期）。匹配 chat_id 或 user_id 任一即可。
    //    拒绝时回报 chat_id，方便管理员把自己加白（只回一次/分钟，避免被刷屏）。
    const allowed = (this.env.ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(m.chatId) && !allowed.includes(m.userId)) {
      console.log(`[tg] 非白名单 chat=${m.chatId}，拒绝`);
      if (await this.allowRate(m.chatId)) {
        await this.reply(
          m.chatId,
          `未授权用户。你的 chat_id 是 ${m.chatId}，请联系管理员加入白名单。`,
        );
      }
      return;
    }

    // 3) 限流
    if (!(await this.allowRate(m.chatId))) {
      await this.reply(m.chatId, `说话慢一点～每分钟最多 ${this.rateLimit()} 条。`);
      return;
    }

    // 4) 日额度（防失控烧钱）
    if (await this.overBudget()) {
      await this.reply(m.chatId, "今天的调用额度用完了，明天再战。");
      return;
    }

    // 5) 文本提取：文本直取；语音下载后走 STT 转写
    let text = m.text;
    let source = "text";
    if (!text && m.voiceFileId) {
      text = await this.transcribeVoice(m.voiceFileId, m.voiceMime);
      source = "stt-api";
    }
    if (!text) {
      await this.reply(m.chatId, "没听清⋯⋯换句话试试，或者直接发文字。");
      return;
    }
    console.log(`[tg] 消息 chat=${m.chatId} source=${source} text=${text.slice(0, 80)}`);

    // 5.5) 身份验证（30 分钟滑动会话）：
    //   - 未验证：一切问题/指令都不转发 LLM，只回验证问题；
    //     若这条消息本身就是正确答案（「爸爸」）→ 通过并延续 30 分钟。
    //   - 已验证：任何交互把会话滑动延续 30 分钟。
    //   - 设备限制由「白名单账号」达成（Telegram 不提供设备信息）。
    const now = Date.now();
    const verifyAnswer = this.env.VERIFY_ANSWER;
    const sessionMs = this.verifySessionMs();
    const state = await this.getVerify(m.chatId);
    if (!isVerified(state, now)) {
      if (verifyAnswer && isAnswerMatch(text, verifyAnswer)) {
        await this.setVerify(m.chatId, nextExpiry(now, sessionMs));
        await this.reply(m.chatId, "验证通过 ✓（半小时内互动免验证）");
        return;
      }
      await this.setVerify(m.chatId, 0); // 保持未验证
      await this.reply(
        m.chatId,
        verifyAnswer ? CHALLENGE_TEXT : `${CHALLENGE_TEXT}\n（管理员未配置验证答案，服务锁定中）`,
      );
      return;
    }
    // 已验证 → 滑动延续
    await this.setVerify(m.chatId, nextExpiry(now, sessionMs));

    // 6.5) 诊断命令：回显最后一轮模型回复的原文格式，定位「高亮不生效」问题。
    // 用可见标记替换围栏/缩进，纯文本发送（不走 mdToV2，避免二次转换干扰判断）。
    if (/^(诊断|\/diag)$/i.test(text.trim())) {
      await this.diagnose(m.chatId, (t) =>
        this.tg.call("sendMessage", { chat_id: m.chatId, text: t, disable_web_page_preview: true }),
      );
      return;
    }

    // 6) 意图解析 + 会话历史 + LLM 路由
    const intent = parseIntent(text);
    const history = await this.getHistory(m.chatId);
    let answer: string;
    let via = "-";
    try {
      const result = await this.runAgent(intent, history);
      answer = result.text;
      via = `${result.provider}/${result.model} ${result.latencyMs}ms`;
    } catch (e) {
      console.error("[agent]", e);
      answer = `所有模型都调用失败了：${e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150)}`;
    }

    await this.appendHistory(m.chatId, "user", text);
    await this.appendHistory(m.chatId, "assistant", answer);
    await this.incrBudget();

    // 7) 分段回包
    await this.reply(m.chatId, answer);
    console.log(`[tg] 已回复 chat=${m.chatId} via ${via}`);
  }

  private async runAgent(intent: Intent, history: { role: string; content: string }[]): Promise<ChatResult> {
    const providers = loadProviders(this.env);
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.slice(-this.maxTurns() * 2),
      { role: "user", content: intent.prompt },
    ];
    const chain = intent.chain.length > 0 ? intent.chain : [this.defaultProvider(intent)];
    const effort = effortFor(intent);
    // 旗舰档（high 思考）值得等，给足 120s；其余 45s 快速失败 → 降级 fast 模型
    const timeoutMs = effort === "high" ? 120_000 : 45_000;
    // 闲聊且没点名厂商 → 首选 flash-lite（默认不思考，实测 ~3s）。
    // 3.8-flash 不收 minimal（直接 400），所以闲聊不能把它放主路；
    // 降级路径上若落到 3.7/3.8 Flash，clampEffort 会自动把 minimal 兜底成 low。
    const preferFast =
      intent.taskType === "chat" && intent.modelTier !== "flagship" && intent.chain.length === 0;
    return chatChain(providers, chain, {
      messages,
      tier: intent.modelTier,
      maxTokens: Number(this.env.MAX_OUTPUT_TOKENS ?? 4096),
      reasoningEffort: effort,
      timeoutMs,
      preferFastModel: preferFast,
    });
  }

  private defaultProvider(intent: Intent): string {
    return intent.taskType === "code"
      ? this.env.DEFAULT_CODING_PROVIDER || "gemini"
      : this.env.DEFAULT_CHAT_PROVIDER || "gemini";
  }

  /** 下载 Telegram 语音文件并转写为文字。 */
  private async transcribeVoice(fileId: string, mime: string | null): Promise<string> {
    if (!this.env.STT_BASE_URL || !this.env.STT_API_KEY) {
      console.log("[tg] 语音消息但未配置 STT_BASE_URL/STT_API_KEY");
      return "";
    }
    try {
      const file = await this.tg.getFile(fileId);
      if (!file.file_path) return "";
      const audio = await fetch(this.tg.fileUrl(file.file_path), { signal: AbortSignal.timeout(30_000) });
      if (!audio.ok) return "";
      const buf = await audio.arrayBuffer();
      return await transcribeBytes(buf, mime ?? "audio/ogg", this.env);
    } catch (e) {
      console.error("[tg] 语音转写失败", e);
      return "";
    }
  }

  /** 分段发送（长回答拆成多条，手表端更好读）。 */
  private async reply(chatId: string, text: string): Promise<void> {
    const chunks = chunkText(text, Number(this.env.REPLY_CHUNK_SIZE ?? 800));
    for (const chunk of chunks) {
      await this.tg.sendMessage(chatId, chunk);
    }
  }

  // ---------------------------------------------------------------- 诊断

  /**
   * 诊断：回显最后一轮模型回复的原文，回答「高亮为什么不生效」。
   * 可能结论：① 模型没用围栏（含缩进=是/围栏=否 → 兜底漏了某种形态）
   * ② 模型用了围栏但 Telegram 侧渲染差异 ③ 发送被 400 降级（回复纯文本无样式）。
   */
  private async diagnose(chatId: string, send: (text: string) => Promise<void>): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{ role: string; content: string }>(
        "SELECT role, content FROM history WHERE chat_id = ? ORDER BY ts DESC LIMIT 6",
        chatId,
      )
      .toArray();
    const lastUser = rows.find((r) => r.role === "user");
    const lastAssistant = rows.find((r) => r.role === "assistant"); // DESC 序，第一个即最新
    const raw = lastAssistant?.content ?? "";
    const visible = (s: string) =>
      s
        .replace(/```/g, "〔FENCE〕")
        .replace(/^( {4}|\t)/gm, "〔IND〕$&")
        .slice(0, 400);
    const report = [
      `诊断报告 build=${BUILD}`,
      `通道: tg=${this.tg ? "on" : "off"}`,
      `最近输入: ${(lastUser?.content ?? "无").slice(0, 80)}`,
      `模型回复含围栏: ${/```/.test(raw) ? "是" : "否"}`,
      `模型回复含缩进行: ${/^( {4}|\t)/m.test(raw) ? "是" : "否"}`,
      "模型回复原文（前400字，围栏→〔FENCE〕 缩进行→〔IND〕）:",
      visible(raw),
    ].join("\n");
    await send(report);
  }

  // ---------------------------------------------------------------- 状态存储

  private async seenMsg(key: string): Promise<boolean> {
    const rows = this.ctx.storage.sql.exec<{ n: number }>("SELECT 1 AS n FROM seen_msgs WHERE msg_id = ?", key).toArray();
    return rows.length > 0;
  }

  private async markSeen(key: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO seen_msgs (msg_id, ts) VALUES (?, ?)", key, now);
    this.ctx.storage.sql.exec("DELETE FROM seen_msgs WHERE ts < ?", now - 3_600_000);
  }

  private async allowRate(chatId: string): Promise<boolean> {
    const minute = Math.floor(Date.now() / 60_000);
    this.ctx.storage.sql.exec(
      "INSERT INTO rate (chat_id, minute, n) VALUES (?, ?, 1) ON CONFLICT(chat_id, minute) DO UPDATE SET n = n + 1",
      chatId,
      minute,
    );
    const rows = this.ctx.storage
      .sql.exec<{ n: number }>("SELECT n FROM rate WHERE chat_id = ? AND minute = ?", chatId, minute)
      .toArray();
    this.ctx.storage.sql.exec("DELETE FROM rate WHERE minute < ?", minute - 10);
    return (rows[0]?.n ?? 1) <= this.rateLimit();
  }

  private async overBudget(): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const rows = this.ctx.storage.sql.exec<{ n: number }>("SELECT n FROM budget WHERE day = ?", day).toArray();
    return (rows[0]?.n ?? 0) >= this.dailyBudget();
  }

  private async incrBudget(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    this.ctx.storage.sql.exec(
      "INSERT INTO budget (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1",
      day,
    );
    this.ctx.storage.sql.exec("DELETE FROM budget WHERE day < ?", day);
  }

  private async getHistory(chatId: string): Promise<{ role: string; content: string }[]> {
    const limit = this.maxTurns() * 2;
    const rows = this.ctx.storage
      .sql.exec<{ role: string; content: string }>(
        "SELECT role, content FROM history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?",
        chatId,
        limit,
      )
      .toArray();
    return rows.reverse();
  }

  private async appendHistory(chatId: string, role: string, content: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO history (chat_id, role, content, ts) VALUES (?, ?, ?, ?)",
      chatId,
      role,
      content.slice(0, 4000),
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM history WHERE chat_id = ? AND ts < (
         SELECT MIN(ts) FROM (SELECT ts FROM history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?)
       )`,
      chatId,
      chatId,
      this.maxTurns() * 2,
    );
  }

  // ---------------------------------------------------------------- 配置读取

  private maxTurns(): number {
    return Number(this.env.SESSION_MAX_TURNS ?? 10);
  }
  private rateLimit(): number {
    return Number(this.env.RATE_LIMIT_PER_MIN ?? 20);
  }
  private dailyBudget(): number {
    return Number(this.env.DAILY_CALL_BUDGET ?? 200);
  }

  /** 验证会话时长（分钟，默认 30） */
  private verifySessionMs(): number {
    const min = Number(this.env.VERIFY_SESSION_MIN ?? 30);
    return (Number.isFinite(min) && min > 0 ? min : 30) * 60_000;
  }

  // ---------------------------------------------------------------- 验证会话存储

  private async getVerify(chatId: string): Promise<VerifyState | undefined> {
    const key = `verify:${chatId}`;
    const v = await this.ctx.storage.get<number>(key);
    return v === undefined ? undefined : { exp: v };
  }

  private async setVerify(chatId: string, exp: number): Promise<void> {
    this.ctx.storage.put(`verify:${chatId}`, exp);
  }

  private async status(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      build: BUILD,
      channel: "telegram",
    };
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS seen_msgs (msg_id TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE IF NOT EXISTS history (chat_id TEXT, role TEXT, content TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_history ON history(chat_id, ts);
CREATE TABLE IF NOT EXISTS rate (chat_id TEXT, minute INTEGER, n INTEGER, PRIMARY KEY(chat_id, minute));
CREATE TABLE IF NOT EXISTS budget (day TEXT, n INTEGER, PRIMARY KEY(day));
`;
