/**
 * Gemini 免费额度识别（纯逻辑，可单测）。
 *
 * chatbot 的 LLM 路由是统一的 OpenAI 兼容 /chat/completions（见 router/providers.ts），
 * 主厂商是 Gemini。Gemini 免费层被打满时会返回 HTTP 429 / RESOURCE_EXHAUSTED 等。
 * chatChain 把所有厂商的失败聚合成一句：
 *   "所有厂商均失败 -> gemini: [gemini/x] HTTP 429: {...} | deepseek: [...]"
 * 这里把这句解析出来，判断「是不是 Gemini 免费额度耗尽」。
 */

export interface ProviderError {
  provider: string;
  model: string;
  status?: number;
  message: string;
  raw: string;
}

const SEG_RE = /^([^\s:]+):\s*\[([^\]]*)\](?:\s+HTTP\s+(\d+))?[\s:]*([\s\S]*)$/;

/** 把 chatChain 的聚合错误拆成「厂商级」失败条目。 */
export function parseChainError(full: string): ProviderError[] {
  const body = String(full).replace(/^所有厂商均失败\s*->\s*/, "");
  const out: ProviderError[] = [];
  for (const seg of body.split(" | ")) {
    const m = seg.match(SEG_RE);
    if (!m) continue;
    out.push({
      provider: m[1],
      model: m[2],
      status: m[3] ? Number(m[3]) : undefined,
      message: m[4] ?? "",
      raw: seg,
    });
  }
  return out;
}

/** 命中免费额度/限流的关键字或状态码。 */
const QUOTA_HINTS: RegExp[] = [
  /\b429\b/,
  /HTTP\s*429/i,
  /quota/i,
  /RESOURCE_EXHAUSTED/i,
  /rate[_\s-]?limit/i,
  /exhausted/i,
  /too many requests/i,
  /免费.*额度|额度.*(用完|耗尽)|free.*tier/i,
];

export function hasQuotaHint(text: string): boolean {
  return QUOTA_HINTS.some((re) => re.test(text));
}

/**
 * 判断某次调用失败是否由「Gemini 免费额度耗尽」导致。
 *   - 整体错误必须先带配额/限流特征；
 *   - 能解析出厂商段时，要求失败链里「gemini」段也带配额特征（避免把别的厂商 429 算到 Gemini 头上）；
 *   - 解析不出多段（单厂商直接抛错）时，退化为「意图厂商是 gemini」判定。
 */
export function isGeminiQuotaError(err: unknown, intendedProvider: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!hasQuotaHint(msg)) return false;
  const segs = parseChainError(msg);
  if (segs.length > 0) {
    return segs.some((s) => s.provider === "gemini" && hasQuotaHint(s.raw));
  }
  return intendedProvider === "gemini";
}
