/**
 * Worker 入口：Telegram 通道。无长连接、无 cron——事件驱动，按需唤醒 DO。
 *   GET  /healthz                 → DO 状态（build 等，部署后验收用）
 *   GET  /setup                   → 一次性注册 webhook（setWebhook 指向本 worker 的 /webhook）
 *   POST /webhook                 → Telegram 事件推送入口
 *   GET  /send?text=&chat_id=     → 调试：主动推一条文本
 */
import type { Env } from "./env";
import { endpoints } from "./config";
import { TelegramClient } from "./telegram/client";

// Durable Object 必须从入口导出（wrangler 据此注册绑定）
export { AssistantDO } from "./bot-do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 顶层 try/catch：任何未捕获异常都转成可读 JSON，而不是 opaque 的 1101
    try {
      const url = new URL(request.url);
      const stub = env.BOT.get(env.BOT.idFromName("singleton"));

      if (url.pathname === "/healthz") {
        const r = await stub.fetch("http://do/status");
        return Response.json({ ok: true, ...((await r.json()) as Record<string, unknown>) });
      }

      if (url.pathname === "/setup") {
        if (!env.TELEGRAM_BOT_TOKEN) {
          return Response.json(
            { ok: false, error: "TELEGRAM_BOT_TOKEN 未配置。先运行: npx wrangler secret put TELEGRAM_BOT_TOKEN" },
            { status: 400 },
          );
        }
        const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, endpoints(env).telegramApiBase);
        const callback = `${url.origin}/webhook`;
        const ok = await tg.setWebhook(callback, env.TELEGRAM_WEBHOOK_SECRET);
        const info = await tg.getWebhookInfo();
        return Response.json({ ok, callback, webhook: info });
      }

      if (url.pathname === "/webhook" && request.method === "POST") {
        // 原样透传 headers + body 流（secret_token 校验在 DO 内做）
        return stub.fetch(
          new Request("http://do/webhook", {
            method: "POST",
            headers: request.headers,
            body: request.body,
          }),
        );
      }

      if (url.pathname === "/send") {
        return stub.fetch(`http://do/send?${url.searchParams.toString()}`);
      }

      return new Response("watch-ai assistant (telegram). try /healthz or /setup", { status: 200 });
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },

  // webhook 模式无需 cron。保留 no-op 以兼容历史部署残留的 Cron Trigger
  // （触发器粘性，删 [triggers] 段未必移除，wrangler.toml 已显式置空）。
  async scheduled(): Promise<void> {
    /* no-op：事件驱动，无常驻任务 */
  },
} satisfies ExportedHandler<Env>;
