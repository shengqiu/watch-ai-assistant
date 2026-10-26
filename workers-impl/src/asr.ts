/**
 * 语音识别（ASR）。
 * Workers 上没有 Python/ffmpeg，跑不了本地 Whisper，因此语音统一走
 * 「OpenAI 兼容 /audio/transcriptions」端点。Telegram 语音是 OGG/Opus，
 * 由 DO 下载成字节后交给这里转写。
 *
 * 免费 ASR 推荐（任选其一，填到 STT_BASE_URL / STT_API_KEY / STT_MODEL）：
 *   - Groq Whisper：base=https://api.groq.com/openai/v1  model=whisper-large-v3（免费额度大）
 *   - OpenAI：base=https://api.openai.com/v1            model=whisper-1
 *   - SiliconFlow：base=https://api.siliconflow.cn/v1   model=FunAudioLLM/SenseVoiceSmall
 */
import type { Env } from "./env";

/** 把语音字节送到 OpenAI 兼容 STT 端点转写；未配置或失败返回空串。 */
export async function transcribeBytes(bytes: ArrayBuffer, mime: string, env: Env): Promise<string> {
  if (!env.STT_BASE_URL || !env.STT_API_KEY) return "";
  try {
    const fd = new FormData();
    // Whisper 系按内容识别，扩展名给 .ogg（Telegram 语音即 OGG/Opus）
    const ext = mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : "ogg";
    fd.append("file", new Blob([bytes], { type: mime || "audio/ogg" }), `voice.${ext}`);
    fd.append("model", env.STT_MODEL || "whisper-large-v3");
    const resp = await fetch(`${env.STT_BASE_URL.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.STT_API_KEY}` },
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) return "";
    const data = (await resp.json()) as { text?: string };
    return (data.text ?? "").trim();
  } catch {
    return "";
  }
}

/** 片段：围栏代码块内 或 普通文本 */
interface Segment { code: boolean; lang: string; body: string }

/**
 * 把文本切成「代码块/普通文本」片段。围栏容忍未闭合（算到结尾）——
 * LLM 偶尔输出不闭合的 ```，这里按块处理，渲染层再降级为字面量。
 */
function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([^\n]*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push({ code: false, lang: "", body: text.slice(last, m.index) });
    out.push({ code: true, lang: m[1].trim(), body: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, lang: "", body: text.slice(last) });
  return out;
}

/** 普通文本按「换行 → 空格 → 硬断」切成 ≤ size 的条 */
function splitPlain(body: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = body.trim();
  while (rest.length > size) {
    let cut = -1;
    const nl = rest.lastIndexOf("\n", size);
    if (nl > size * 0.5) cut = nl;
    else {
      const sp = rest.lastIndexOf(" ", size);
      if (sp > size * 0.5) cut = sp;
    }
    if (cut <= 0) cut = size;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * 长文本分段（手表端适合短消息）。
 * 代码块感知：绝不在 ``` 围栏内切断；超长代码块按行切、每段补全围栏，
 * 保证输出每段都是合法 markdown（渲染层才能正确转成 MarkdownV2）。
 */
export function chunkText(text: string, size: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  const fenced = (lang: string, body: string): string =>
    "```" + (lang ? lang + "\n" : "\n") + body + "\n```";

  for (const seg of splitSegments(clean)) {
    if (!seg.code) {
      for (const piece of splitPlain(seg.body, size)) {
        if (cur && cur.length + piece.length + 1 > size) flush();
        cur = cur ? cur + "\n" + piece : piece;
      }
      continue;
    }
    // 代码块：整块放得下就并入当前块（放不下先开新块，避免和前文藕断丝连）
    const whole = fenced(seg.lang, seg.body);
    if (whole.length <= size) {
      if (cur && cur.length + whole.length + 1 > size) flush();
      cur = cur ? cur + "\n" + whole : whole;
      continue;
    }
    // 超长代码块：按行贪心装，每批补全围栏（视觉上呈连续代码段）
    flush();
    const overhead = seg.lang.length + 10; // ```lang\n + \n```
    const budget = Math.max(size - overhead, 10);
    let buf: string[] = [];
    const emit = () => {
      if (buf.length) chunks.push(fenced(seg.lang, buf.join("\n")));
      buf = [];
    };
    for (const line of seg.body.split("\n")) {
      if (line.length > budget) {
        // 单行超长（压缩代码）：硬断
        emit();
        for (let i = 0; i < line.length; i += budget) {
          chunks.push(fenced(seg.lang, line.slice(i, i + budget)));
        }
        continue;
      }
      const joined = buf.length ? buf.join("\n").length + 1 + line.length : line.length;
      if (joined > budget) emit();
      buf.push(line);
    }
    emit();
  }
  flush();
  return chunks;
}
