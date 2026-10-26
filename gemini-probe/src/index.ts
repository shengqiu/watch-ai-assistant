/**
 * gemini-probe：CF Workers 出口 → Google Gemini API 连通性探针。
 *
 * 背景：Bot 报「所有模型超时」（gemini-3.8-flash / flash-lite 均 45s timeout），
 * 需区分三种根因：① CF 出口到 generativelanguage.googleapis.com 网络不通
 * ② API key 失效/限额 ③ Google 服务端故障。
 *
 * 用法：手机/电脑浏览器打开 https://gemini-probe.<你的子域>.workers.dev/
 */

import targetsJson from "../targets.json" with { type: "json" };

const API_ROOT_URL: string = targetsJson.apiRootUrl;
const GENERATE_CONTENT_URL: string = targetsJson.generateContentUrl;
const CONTROLS: { name: string; url: string; note: string }[] = targetsJson.controlProbes;

interface ProbeResult {
  name: string;
  url: string;
  note: string;
  ok: boolean;
  status: string;
  ms: number;
}

async function probeGet(t: { name: string; url: string; note: string }): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const resp = await fetch(t.url, { method: "GET", signal: AbortSignal.timeout(10000) });
    const body = await resp.text().catch(() => "");
    let status = `HTTP ${resp.status}`;
    if (resp.status === 401 || resp.status === 403) {
      status += "（服务活着，只是没带有效 key）";
    } else if (body.length > 0 && body.length < 200) {
      status += ` ${body.slice(0, 120)}`;
    }
    return { ...t, ok: true, status, ms: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...t, ok: false, status: msg.slice(0, 120), ms: Date.now() - started };
  }
}

export default {
  async fetch(): Promise<Response> {
    const started = Date.now();
    // ① 网络层：API 根（无 key，期望 401/403 = 可达）
    const root = await probeGet({
      name: "Gemini API 根（测网络）",
      url: API_ROOT_URL,
      note: "401/403=网络通；timeout=网络挂",
    });
    // ② 真实调用路径：generateContent 带无效 key
    //    403 invalid key = 服务活着；timeout = 网络挂；429 = 限额
    const genStarted = Date.now();
    let genStatus: string;
    let genOk = false;
    try {
      const resp = await fetch(GENERATE_CONTENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await resp.text().catch(() => "");
      genOk = true;
      genStatus = `HTTP ${resp.status} ${body.slice(0, 150)}`;
    } catch (e) {
      genStatus = (e instanceof Error ? e.message : String(e)).slice(0, 150);
    }
    // ③ 对照：Google 主站 + Telegram API（已知可达，地址在 targets.json）
    const controls = await Promise.all(CONTROLS.map(probeGet));

    const results: ProbeResult[] = [
      root,
      { name: "generateContent 调用（无效 key）", url: "…gemini-3.5-flash-lite:generateContent", note: "403 key invalid=服务活着", ok: genOk, status: genStatus, ms: Date.now() - genStarted },
      ...controls,
    ];

    let verdict: string;
    if (!root.ok || !genOk) {
      verdict = "❌ CF 出口到 Gemini API 网络不通（timeout/连接失败）——与 key 无关，等 Google 恢复或考虑换出口";
    } else if (/HTTP 429/.test(genStatus)) {
      verdict = "⚠️ 配额/限额（429）——key 还有效但被限流，等重置或升配额";
    } else if (/HTTP 40[13]/.test(genStatus)) {
      verdict = "✅ 服务活着且可达（invalid key 被正常拒绝）——线上超时是偶发/服务端波动，重试即可";
    } else {
      verdict = `⚠️ 异常状态：${genStatus.slice(0, 120)}——把本页发给助手分析`;
    }

    const rows = results
      .map(
        (r) =>
          `<tr><td>${r.name}</td><td><code>${r.url}</code></td>` +
          `<td class="${r.ok ? "ok" : "bad"}">${r.status}</td><td>${r.ms}ms</td><td>${r.note}</td></tr>`,
      )
      .join("");
    const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gemini 连通性探针</title><style>
body{font-family:-apple-system,sans-serif;max-width:820px;margin:20px auto;padding:0 16px;background:#f5f5f7}
h1{font-size:20px}.v{font-size:15px;padding:12px 16px;border-radius:10px;margin:12px 0;background:#fff;line-height:1.6}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:13px}
td,th{padding:10px;text-align:left;border-bottom:1px solid #eee;vertical-align:top}.ok{color:#0a7d2c;font-weight:600}.bad{color:#c0392b;font-weight:600}
code{font-size:12px;word-break:break-all}.meta{color:#888;font-size:12px;margin-top:12px}
</style></head><body>
<h1>Gemini 连通性探针 <small style="color:#888">gemini-probe</small></h1>
<div class="v">${verdict}</div>
<table><tr><th>目标</th><th>地址</th><th>结果</th><th>耗时</th><th>说明</th></tr>${rows}</table>
<p class="meta">执行时间: ${new Date().toISOString()} · 总耗时 ${Date.now() - started}ms · 可刷新重复测试</p>
</body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
