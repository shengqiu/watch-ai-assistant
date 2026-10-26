/** 环境绑定类型：vars 走 wrangler.toml [vars]，密钥走 wrangler secret put。 */
export interface Env {
  // Durable Object 绑定
  BOT: DurableObjectNamespace<AssistantDO>;

  // Telegram 机器人令牌（secret，@BotFather 处获取）
  TELEGRAM_BOT_TOKEN: string;
  // 可选：webhook 防伪密钥（setWebhook 的 secret_token，自定义一串随机串即可）
  TELEGRAM_WEBHOOK_SECRET?: string;

  // 外部服务地址（可选；默认官方地址，集中解析见 src/config.ts。
  // 换代理 / 换区域端点 / 内网联调时覆盖，无需改代码）
  TELEGRAM_API_BASE?: string; // 默认 https://api.telegram.org

  // 模型厂商密钥（secret，按需填；未填的厂商自动跳过）
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  ZHIPU_API_KEY?: string;
  MOONSHOT_API_KEY?: string;

  // 语音识别（secret，可选）：Telegram 语音需经此转写。免费推荐 Groq Whisper
  STT_BASE_URL?: string;
  STT_API_KEY?: string;
  STT_MODEL?: string;

  // 行为配置（vars）
  ALLOWED_USERS?: string; // 逗号分隔的 chat_id 白名单；空 = 放开
  DEFAULT_CODING_PROVIDER?: string;
  DEFAULT_CHAT_PROVIDER?: string;
  MAX_OUTPUT_TOKENS?: string;
  SESSION_MAX_TURNS?: string;
  RATE_LIMIT_PER_MIN?: string;
  DAILY_CALL_BUDGET?: string;
  REPLY_CHUNK_SIZE?: string;

  // 身份验证会话（「爸爸」挑战）：答案（var/secret，默认「爸爸」）+ 会话时长（分钟，默认 30）
  VERIFY_ANSWER?: string;
  VERIFY_SESSION_MIN?: string;
}

// DurableObjectNamespace 是 workers-types 的全局类型（v5 无需 import）。
// AssistantDO 仅作类型引用，用 import type 避免运行时环。
import type { AssistantDO } from "./bot-do";
