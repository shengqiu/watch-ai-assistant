/**
 * Telegram Bot API 客户端（极薄封装）。
 * 纯 HTTPS REST，无 WebSocket、无签名、无备案——与 Cloudflare Workers 天然契合：
 *   - 收：Telegram 主动 webhook POST 到 /webhook（或 Worker 主动 getUpdates 长轮询）
 *   - 发：sendMessage / getFile / 下载语音文件
 * 文档：https://core.telegram.org/bots/api
 */
import type { TgFile, TgSentMessage } from "./types";
import { mdToV2 } from "./markdown";

export class TelegramClient {
  constructor(
    private readonly token: string,
    /** API 根地址，默认官方 https://api.telegram.org；由 src/config.ts 从环境变量解析后注入 */
    private readonly apiBase: string = "https://api.telegram.org",
  ) {}

  private get base(): string {
    return `${this.apiBase}/bot${this.token}`;
  }

  /** 统一调用入口；失败抛错（带 Telegram 返回的 description）。 */
  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const resp = await fetch(`${this.base}/${method}`, {
      method: params ? "POST" : "GET",
      headers: params ? { "Content-Type": "application/json" } : undefined,
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await resp.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };
    if (!j.ok) {
      throw new Error(`telegram ${method} 失败: HTTP ${j.error_code ?? resp.status} ${j.description ?? ""}`);
    }
    return j.result as T;
  }

  /** 注册 webhook：让 Telegram 把消息推到 callbackUrl。secretToken 可选（防伪请求）。 */
  setWebhook(callbackUrl: string, secretToken?: string): Promise<boolean> {
    return this.call<boolean>("setWebhook", {
      url: callbackUrl,
      allowed_updates: ["message"],
      drop_pending_updates: false,
      ...(secretToken ? { secret_token: secretToken } : {}),
    });
  }

  getWebhookInfo(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("getWebhookInfo");
  }

  getMe(): Promise<{ id: number; username?: string; first_name: string }> {
    return this.call("getMe");
  }

  /**
   * 发消息。默认以 MarkdownV2 渲染（LLM 的 ``` 代码块会变成真正的代码块，
   * 手表端可读性大幅提升）；文本先经 mdToV2 安全转义，正常不会触发 400。
   * 万一 Telegram 仍拒收（4xx，如极端边界），自动降级纯文本重发——消息必达。
   */
  async sendMessage(chatId: number | string, text: string): Promise<TgSentMessage> {
    try {
      return await this.call<TgSentMessage>("sendMessage", {
        chat_id: chatId,
        text: mdToV2(text),
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/HTTP 4\d\d/.test(msg)) throw e; // 网络类/5xx 错误不重试，直接抛
      console.warn(`[tg] MarkdownV2 被拒收，降级纯文本重发：${msg.slice(0, 150)}`);
      return await this.call<TgSentMessage>("sendMessage", {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      });
    }
  }

  getFile(fileId: string): Promise<TgFile> {
    return this.call<TgFile>("getFile", { file_id: fileId });
  }

  /** 语音文件下载直链（注意是 /file/bot 而不是 /bot）。 */
  fileUrl(filePath: string): string {
    return `${this.apiBase}/file/bot${this.token}/${filePath}`;
  }
}
