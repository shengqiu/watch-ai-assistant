/**
 * LLM 路由：统一 OpenAI 兼容 /chat/completions + 多厂商 fallback。
 * 所有厂商（Gemini / GPT / DeepSeek / 通义 / 智谱 / Kimi / 本地）同一套代码，
 * 切换厂商只改 providers.json。Gemini 用官方 OpenAI 兼容端点：
 *   https://generativelanguage.googleapis.com/v1beta/openai/
 */
import providersJson from "../../providers.json" with { type: "json" };
import type { Env } from "../env";
import type { ModelTier } from "./intent";

export interface ProviderCfg {
  name: string;
  base_url: string;
  api_key: string;
  default_model: string;
  flagship_model: string;
  fast_model: string;
  enabled: boolean;
  extra_headers: Record<string, string>;
  /** gpt-5 / o 系列需改为 max_completion_tokens */
  max_tokens_field: string;
  /** 是否支持 OpenAI 兼容端的 reasoning_effort（Gemini 3 系支持；其他厂商不传，免 400） */
  supports_reasoning_effort: boolean;
}

/** Gemini 3 系思考无法关闭，只能压档：minimal < low < medium < high（默认不传 = 模型默认，通常很高） */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandEnv(value: unknown, env: Env): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_m, name: string) => (env as unknown as Record<string, string | undefined>)[name] ?? "");
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v, env);
    return out;
  }
  return value;
}

/** 从 providers.json 加载厂商配置；${ENV} 占位符用 env 密钥展开；无 key 的厂商自动禁用。 */
export function loadProviders(env: Env): Record<string, ProviderCfg> {
  const raw = expandEnv(providersJson.providers, env) as Record<string, Partial<ProviderCfg>>;
  const out: Record<string, ProviderCfg> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    const enabled = cfg.enabled !== false && Boolean(cfg.api_key);
    if (!enabled) continue; // 未启用或没填 key 的厂商直接不进路由表
    out[name] = {
      name,
      base_url: cfg.base_url ?? "",
      api_key: cfg.api_key ?? "",
      default_model: cfg.default_model ?? "",
      flagship_model: cfg.flagship_model ?? cfg.default_model ?? "",
      fast_model: cfg.fast_model ?? cfg.default_model ?? "",
      enabled: true,
      extra_headers: (cfg.extra_headers ?? {}) as Record<string, string>,
      max_tokens_field: cfg.max_tokens_field ?? "max_tokens",
      supports_reasoning_effort: cfg.supports_reasoning_effort === true,
    };
  }
  return out;
}

export function modelFor(cfg: ProviderCfg, tier: ModelTier): string {
  if (tier === "flagship") return cfg.flagship_model || cfg.default_model;
  if (tier === "fast") return cfg.fast_model || cfg.default_model;
  return cfg.default_model;
}

/**
 * 模型尝试顺序（首选 + 降级链，去重）。
 * preferFast = 闲聊场景：首选 fast 模型（Flash-Lite 默认不思考，实测 ~3s），
 * 失败再回退 tier 对应模型；否则默认 [tier 模型, fast 模型]。
 */
export function modelOrder(cfg: ProviderCfg, tier: ModelTier, preferFast = false): string[] {
  const tierModel = modelFor(cfg, tier);
  const ordered = preferFast ? [cfg.fast_model || tierModel, tierModel] : [tierModel, cfg.fast_model];
  return ordered.filter((m, i, a) => Boolean(m) && a.indexOf(m) === i);
}

/**
 * 按模型钳制思考档位。
 * 实测（2026-10-25）：Gemini 3.7/3.8 Flash 起 minimal 档被移除，传了直接 HTTP 400
 * （"Thinking level is unsupported: THINKING_LEVEL_MINIMAL"）——Google 官方兼容层
 * 文档的映射表尚未更新（无 3.7/3.8 列），以实测为准：落到这些模型时自动降档 low。
 * 3.1 Pro 的 minimal 在官方表中也是映射到 low，一并钳制，保底不 400。
 * Flash-Lite 系（3.5/3.1）仍然接受 minimal。
 */
export function clampEffort(model: string, effort?: ReasoningEffort): ReasoningEffort | undefined {
  if (effort === "minimal" && /^gemini-(3\.[78]-flash|3\.1-pro)/.test(model)) return "low";
  return effort;
}

export async function chat(
  providers: Record<string, ProviderCfg>,
  opts: {
    provider: string;
    messages: { role: string; content: string }[];
    tier?: ModelTier;
    maxTokens?: number;
    temperature?: number;
    /** 思考档位（仅 supports_reasoning_effort 的厂商会真正下发；按模型自动钳制） */
    reasoningEffort?: ReasoningEffort;
    /** 单次尝试超时 ms（默认 60s；旗舰档可放宽） */
    timeoutMs?: number;
    /** 闲聊场景：首选 fast 模型（见 modelOrder） */
    preferFastModel?: boolean;
  },
): Promise<ChatResult> {
  const cfg = providers[opts.provider];
  if (!cfg) throw new Error(`厂商不可用或未配置 key: ${opts.provider}`);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const errors: string[] = [];
  for (const model of modelOrder(cfg, opts.tier ?? "default", opts.preferFastModel)) {
    const effort = clampEffort(model, opts.reasoningEffort);
    const started = Date.now();
    try {
      const payload: Record<string, unknown> = {
        model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        [cfg.max_tokens_field]: opts.maxTokens ?? 4096,
      };
      // reasoning_effort 只对声明支持的厂商下发，避免其他厂商 400
      if (effort && cfg.supports_reasoning_effort) {
        payload.reasoning_effort = effort;
      }
      const resp = await fetch(`${cfg.base_url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.api_key}`,
          "Content-Type": "application/json",
          ...cfg.extra_headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`[${opts.provider}/${model}] HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error(`[${opts.provider}/${model}] 响应无内容: ${JSON.stringify(data).slice(0, 300)}`);
      return {
        text,
        provider: opts.provider,
        model,
        promptTokens: Number(data.usage?.prompt_tokens ?? 0),
        completionTokens: Number(data.usage?.completion_tokens ?? 0),
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${model}: ${msg}`);
      // 降级不再静默：主模型失败要在 tail 里可见（否则质量悄悄打折扣都没人知道）
      console.warn(`[router] ${opts.provider}/${model} 失败（effort=${effort ?? "-"}）：${msg.slice(0, 200)}`);
    }
  }
  throw new Error(`[${opts.provider}] 全部模型失败 -> ${errors.join(" | ")}`);
}

/** 按链依次尝试，全部失败才抛错（fallback 的核心）。 */
export async function chatChain(
  providers: Record<string, ProviderCfg>,
  chain: string[],
  opts: {
    messages: { role: string; content: string }[];
    tier?: ModelTier;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: ReasoningEffort;
    timeoutMs?: number;
    preferFastModel?: boolean;
  },
): Promise<ChatResult> {
  const errors: string[] = [];
  for (const provider of chain) {
    try {
      return await chat(providers, { ...opts, provider });
    } catch (e) {
      errors.push(`${provider}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`所有厂商均失败 -> ${errors.join(" | ")}`);
}
