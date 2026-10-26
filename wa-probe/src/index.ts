/**
 * wa-probe：CF Workers 出口 → Meta/WhatsApp 端点连通性探针。
 *
 * 背景：评估 WhatsApp Cloud API 通道（webhook 收消息+语音、watchOS 有客户端）。
 * webhook 方向（Meta → workers.dev）全球可达无疑；关键验证反方向——
 * CF 出口调用 graph.facebook.com（发消息、换媒体 URL）是否被挡。
 *
 * 用法：手机/电脑浏览器打开 https://wa-probe.<你的子域>.workers.dev/
 */

import targetsJson from "../targets.json" with { type: "json" };

const TARGETS: { name: string; url: string; note: string }[] = targetsJson.targets;

interface ProbeResult {
  name: string;
  url: string;
  note: string;
  ok: boolean;
  status: string;
  ms: number;
}

async function probe(t: { name: string; url: string; note: string }): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const resp = await fetch(t.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    return { ...t, ok: true, status: `HTTP ${resp.status}`, ms: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...t, ok: false, status: msg.slice(0, 120), ms: Date.now() - started };
  }
}

export default {
  async fetch(): Promise<Response> {
    const results = await Promise.all(TARGETS.map(probe));
    const graph = results[0];
    const verdict = graph.ok
      ? "✅ 通！CF 出口能直达 Meta Graph API——WhatsApp Cloud API 通道可行，可以开工"
      : "❌ 不通——CF 出口到 Meta 失败，Cloud API 调用（发消息/下载媒体）会被挡";
    const rows = results
      .map(
        (r) =>
          `<tr><td>${r.name}</td><td><code>${r.url}</code></td>` +
          `<td class="${r.ok ? "ok" : "bad"}">${r.status}</td><td>${r.ms}ms</td><td>${r.note}</td></tr>`,
      )
      .join("");
    const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp 连通性探针</title><style>
body{font-family:-apple-system,sans-serif;max-width:760px;margin:20px auto;padding:0 16px;background:#f5f5f7}
h1{font-size:20px}.v{font-size:16px;padding:12px 16px;border-radius:10px;margin:12px 0;background:#fff}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:14px}
td,th{padding:10px;text-align:left;border-bottom:1px solid #eee}.ok{color:#0a7d2c;font-weight:600}.bad{color:#c0392b;font-weight:600}
code{font-size:12px;word-break:break-all}.meta{color:#888;font-size:12px;margin-top:12px}
</style></head><body>
<h1>WhatsApp 连通性探针 <small style="color:#888">wa-probe</small></h1>
<div class="v">${verdict}</div>
<table><tr><th>目标</th><th>地址</th><th>结果</th><th>耗时</th><th>说明</th></tr>${rows}</table>
<p class="meta">执行时间: ${new Date().toISOString()} · 每个请求 8s 超时 · 可刷新重复测试</p>
</body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
