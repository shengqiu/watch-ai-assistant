/**
 * 集中端点配置：所有外部服务地址的唯一解析处。
 *
 * 设计原则：地址不写死在调用处，统一在这里从环境变量解析，
 * 默认值即各平台官方地址——换代理、换区域端点、内网联调都不改代码，
 * 只在 wrangler.toml [vars] / wrang secret / .dev.vars 里覆盖。
 * 模型厂商地址走 providers.json 的 base_url（同为配置），STT 走 STT_BASE_URL。
 */
import type { Env } from "./env";

export interface Endpoints {
  /** Telegram Bot API 根（不含 /bot<token>） */
  telegramApiBase: string;
}

/** 官方默认值。覆盖方式见 wrangler.toml [vars] 注释块 */
export const DEFAULT_ENDPOINTS = {
  telegramApiBase: "https://api.telegram.org",
} as const;

/** 去空白 + 去尾部斜杠；空值回退默认 */
function clean(u: string | undefined, fallback: string): string {
  const v = (u ?? "").trim().replace(/\/+$/, "");
  return v || fallback;
}

export function endpoints(env: Env): Endpoints {
  return {
    telegramApiBase: clean(env.TELEGRAM_API_BASE, DEFAULT_ENDPOINTS.telegramApiBase),
  };
}
