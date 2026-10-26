/**
 * 意图解析：把用户的自然语言（语音转写结果）解析成路由参数。
 * 意图解析（2026-10-24 起主厂商为 Gemini）。
 *
 * 支持的说法：
 *   「用 gemini 帮我写个爬虫」        → provider=gemini
 *   「让 deepseek 重构这个函数」      → provider=deepseek
 *   「@gpt 解释这段报错」             → provider=openai
 *   「先用 deepseek，不行再用 gemini」→ fallback 链 [deepseek, gemini]
 *   「这个问题很复杂，用 pro 档」      → model_tier=flagship
 *   「随便写个 hello world」          → 未指定厂商，走默认策略
 */

export type ModelTier = "default" | "flagship" | "fast";
export type TaskType = "code" | "chat";

export interface Intent {
  raw: string;
  prompt: string;
  /** 首选厂商（null = 走默认策略） */
  provider: string | null;
  modelTier: ModelTier;
  taskType: TaskType;
  /** fallback 链（含首选） */
  chain: string[];
}

/** 厂商别名（可自行扩充；与 providers.json 的 key 对应） */
export const PROVIDER_ALIASES: Record<string, string[]> = {
  gemini: ["gemini", "google", "谷歌", "双子座"],
  anthropic: ["claude", "anthropic", "克劳德", "克洛德"],
  openai: ["gpt", "openai", "chatgpt"],
  deepseek: ["deepseek", "深度求索"],
  qwen: ["qwen", "通义", "千问"],
  zhipu: ["glm", "智谱", "chatglm"],
  moonshot: ["kimi", "moonshot", "月之暗面"],
  doubao: ["doubao", "豆包", "火山方舟"],
  hunyuan: ["hunyuan", "混元"],
  local: ["本地模型", "ollama", "局域网模型"],
};

const FLAGSHIP_WORDS = [
  "opus", "旗舰", "最聪明", "最强", "高质量", "复杂", "困难", "架构设计", "深入", "专家",
];
const FAST_WORDS = [
  "haiku", "flash", "mini", "lite", "快点", "快速", "简单", "随便", "就行", "便宜", "赶时间",
];
const CODE_WORDS = [
  "代码", "函数", "脚本", "接口", "bug", "重构", "实现", "写一个", "写个", "部署", "修复",
  "报错", "sql", "算法", "程序", "爬虫", "页面", "组件", "配置", "docker", "git", "python",
  "java", "golang", "rust", "typescript", "javascript", "html", "css", "优化", "改一下",
  "加上", "单元测试", "diff", "pr", "类", "库",
];

/** 「pro 档 / pro档」→ flagship（\b + 必须带「档」，防止误伤 product/provide） */
const PRO_TIER_RE = /\bpro\s*档/i;

interface Mention {
  pos: number;
  end: number;
  provider: string;
}

/** 找出所有厂商别名提及（按出现顺序；同起点取最长别名，重叠匹配被更长匹配覆盖）。 */
function findMentions(text: string): Mention[] {
  const lowered = text.toLowerCase();
  const raw: { pos: number; len: number; provider: string }[] = [];
  for (const [provider, aliases] of Object.entries(PROVIDER_ALIASES)) {
    for (const alias of aliases) {
      const a = alias.toLowerCase();
      let from = 0;
      for (;;) {
        const idx = lowered.indexOf(a, from);
        if (idx === -1) break;
        // 英文别名要求前后不是字母数字（防 gpt 命中之类问题；中文无此问题但无害）
        const before = idx > 0 ? lowered[idx - 1] : "";
        const afterIdx = idx + a.length;
        const after = afterIdx < lowered.length ? lowered[afterIdx] : "";
        const isAscii = /[a-z0-9]/.test(a[0] ?? "");
        const boundaryOk = !isAscii || (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after));
        if (boundaryOk) raw.push({ pos: idx, len: a.length, provider });
        from = idx + 1;
      }
    }
  }
  raw.sort((x, y) => x.pos - y.pos || y.len - x.len);
  const accepted: Mention[] = [];
  for (const m of raw) {
    const end = m.pos + m.len;
    const overlapped = accepted.some((a) => m.pos < a.end && end > a.pos);
    if (!overlapped) accepted.push({ pos: m.pos, end, provider: m.provider });
  }
  return accepted;
}

/** 去掉路由短语（「用 gemini」「@gpt」等），尽量保留纯任务描述。 */
function cleanPrompt(text: string): string {
  let out = text;
  for (const aliases of Object.values(PROVIDER_ALIASES)) {
    for (const alias of aliases) {
      const a = alias.toLowerCase();
      // 仅当别名以 ASCII 开头时才做边界保护（与 findMentions 一致）
      const pattern = /[a-z0-9]/.test(a[0] ?? "")
        ? new RegExp(`(?<![a-z0-9])${escapeRegExp(a)}(?![a-z0-9])`, "gi")
        : new RegExp(escapeRegExp(a), "gi");
      out = out.replace(pattern, "");
    }
  }
  out = out.replace(/^\s*(请)?(先用|用|让|叫|给|来|@)+\s*/, "");
  out = out.replace(/\s{2,}/g, " ").replace(/^[，,。.、~！!]+|[，,。.、~！!]+$/g, "");
  return out.trim() || text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseIntent(text: string): Intent {
  const mentions = findMentions(text);
  const chain: string[] = [];
  for (const m of mentions) {
    if (!chain.includes(m.provider)) chain.push(m.provider);
  }

  const lowered = text.toLowerCase();
  let tier: ModelTier = "default";
  if (FLAGSHIP_WORDS.some((w) => lowered.includes(w)) || PRO_TIER_RE.test(lowered)) {
    tier = "flagship";
  } else if (FAST_WORDS.some((w) => lowered.includes(w))) {
    tier = "fast";
  }

  const taskType: TaskType = CODE_WORDS.some((w) => lowered.includes(w)) ? "code" : "chat";

  return {
    raw: text,
    prompt: cleanPrompt(text),
    provider: chain[0] ?? null,
    modelTier: tier,
    taskType,
    chain,
  };
}

/**
 * 意图 → 思考档位（仅对支持 reasoning_effort 的厂商生效，如 Gemini 3 系）。
 *
 * 背景：Gemini 3 系思考无法关闭，默认档思考预算很高——手表场景等不起。
 * 实测默认档响应 68~104s；压到 minimal/low 后预期回到秒级。
 *   - 闲聊/简单问答 → minimal（Flash-Lite 甚至完全不思考）
 *   - 写代码       → low（留一点推理，保正确率）
 *   - 明确要旗舰/复杂 → high（用户主动要质量，值得等）
 */
export function effortFor(intent: Intent): "minimal" | "low" | "high" {
  if (intent.modelTier === "flagship") return "high";
  if (intent.modelTier === "fast") return "minimal";
  return intent.taskType === "chat" ? "minimal" : "low";
}
