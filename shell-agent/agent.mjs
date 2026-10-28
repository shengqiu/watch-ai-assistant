#!/usr/bin/env node
/**
 * shell-agent —— codespace 内的「持久 bash」桥接 agent（零依赖，Node 18+）。
 *
 * 为什么需要它：Cloudflare Worker 无法主动 SSH 进 codespace（Workers 不能出站
 * TCP/SSH）。所以方向反过来——由 codespace 里的本进程主动连出去，跟 Worker 建一条
 * SSE 长连接：Worker 收到 Telegram 命令就顺着这条连接推下来，执行完再把输出
 * POST 回去。全程只有出站 HTTPS，codespace 不需要开放任何入站端口。
 *
 * 为什么不是 tmux：tmux 解决的是「多路复用 + 可重连终端」。这里只要一个活着的
 * bash：直接 spawn 一个长驻 `bash -i` 子进程，cwd、环境变量、后台 job 都活在
 * 同一个进程里，跨消息保持。少一层依赖，也更贴近「一个 shell」的直觉。
 *
 * 用法：
 *   WATCH_AI_AGENT_KEY=xxx node shell-agent/agent.mjs
 *   （密钥也可放 ~/.config/watch-ai/agent-key，避免写进命令行历史）
 *
 * 环境变量：
 *   WATCH_AI_WORKER     Worker 基址（默认 watch-ai-devbot…workers.dev）
 *   WATCH_AI_AGENT_KEY  反连密钥（与 Worker 的 AGENT_KEY secret 同值）
 *   WATCH_AI_WORKDIR    初始工作目录（默认 /workspaces/watch-ai-assistant）
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
// proc.mjs 与本文件同目录：相对 import 由 Node 按文件位置解析，
// 所以 supervise.sh 从任何 cwd 拉起 agent 都能找到它。
import { probeTree, judgeIdle, stateLine, fmtDur, procAvailable } from "./proc.mjs";

// ------------------------------------------------------------------ 配置

const WORKER_RAW = (
  process.env.WATCH_AI_WORKER || "https://watch-ai-devbot.shengqiu-purdue.workers.dev"
).replace(/\/+$/, "");

/**
 * 只允许 https（本机调试除外）。
 *
 * 通道里跑的是 root 级命令，走明文 http 等于把密钥和命令都摆在大马路上；
 * 一旦有人把 WATCH_AI_WORKER 打错成 http:// 或中间人换了地址，必须立刻拒绝。
 */
const WORKER = (() => {
  const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(WORKER_RAW);
  if (WORKER_RAW.startsWith("http://") && !local) {
    return WORKER_RAW.replace(/^http:\/\//, "https://");
  }
  return WORKER_RAW;
})();
/** 本机联调地址（只有它能走明文 http，方便本地起假 Worker 做验证）。 */
const WORKER_IS_LOCAL = WORKER.startsWith("http://");

const WORKDIR = process.env.WATCH_AI_WORKDIR || "/workspaces/watch-ai-assistant";

/**
 * 进程探针（见 proc.mjs）：
 * 以前判断「卡死」只看「有没有输出」，于是把「codebuddy 思考 5 分钟」也当成卡死
 * 直接 SIGKILL 整个进程组 —— 长任务必死。现在先读 /proc 看证据再决定。
 */
const NEVER_MOVED_MS = Number(process.env.WATCH_AI_NEVER_MOVED_MS || 600_000);
/** CPU 冻住多久判定真挂死（默认 15 分钟）。S 状态但 CPU 还在涨 = 活着，不算。 */
const STUCK_MS = Number(process.env.WATCH_AI_STUCK_MS || 900_000);
/** 无输出多久开始周期性播报进度（之后每 PROGRESS_MS 一次）。 */
const PROGRESS_MS = Number(process.env.WATCH_AI_PROGRESS_MS || 120_000);
const PROGRESS_REPEAT_MS = Number(process.env.WATCH_AI_PROGRESS_REPEAT_MS || 300_000);

/** 增量输出静默多久就推一条消息（毫秒） */
const FLUSH_MS = Number(process.env.WATCH_AI_FLUSH_MS || 1200);
/** 多久没有任何输出就提示「仍在运行」（不杀进程，只告知）。Gemini 思考常超 20s，故放宽。 */
const STALL_MS = Number(process.env.WATCH_AI_STALL_MS || 30000);
/**
 * 单条命令最多回传多少字符（超出丢弃；Worker 端还有一层掐头尾）。
 * v2026-10-28b 起默认不设实际限制（200 万字符 ≈ 2MB，单条命令根本到不了）：
 * 用户要求「codebuddy 的 stdout 完整发给我」，旧默认 60000 会把长输出的
 * 尾部整段丢掉。内存上不是问题：文本按行 push 进 buf，2MB 远低于 Node 默认堆。
 */
const MAX_CHARS = Number(process.env.WATCH_AI_MAX_CHARS || 2_000_000);
/** 多久没收到 SSE 字节就当死连接重连（Worker 心跳 20s） */
const SILENCE_MS = Number(process.env.WATCH_AI_SILENCE_MS || 60000);
/**
 * 多久「完全没有一个字节的输出」就判定命令卡死并强制回收（毫秒）。
 *
 * 为什么需要这个：2026-10-27 实际踩到——08:46 下发的一条准备脚本，agent.log 里
 * 只有 `exec:` 一行，之后既没有输出、也没有 `done:`，而 agent / script / bash
 * 三个进程全都活着，整整 12 分钟一动不动。Telegram 侧看到的是
 * 「⌨️ 上一条命令还在跑」，而 DO 的队列要等 45 分钟 TTL 才释放 —— 等于通道假死。
 * 光靠「bash 退出就重启」救不了这种「进程活着但没反应」的情况，必须有时间兜底。
 *
 * 选取 240s 的理由：gemini 这种边想边吐的有持续输出，30s 还会收到「仍在运行」提示；
 * 连续 4 分钟零字节基本只有卡死一种解释。想放宽就设 WATCH_AI_WEDGE_MS。
 */
const WEDGE_MS = Number(process.env.WATCH_AI_WEDGE_MS || 240000);
/**
 * 心跳间隔（毫秒）。
 *
 * 为什么不能再靠「SSE 写成功」判断通道活着：连接半死时（TCP 没断、对端进程
 * 已重启或网络黑洞）Worker 那边的 write 照样成功，于是它一直以为在跑命令，
 * 而命令其实压根没送达 —— 2026-10-27 的「上一条命令还在跑：🛠 准备 Gemini 环境」
 * 就是这么来的：agent.log 里连 `exec:` 都没有，用户却被锁到 TTL 到期。
 * 现在由 agent 每 15 秒主动 POST /shell/ping，Worker 只认这个。
 */
const PING_MS = Number(process.env.WATCH_AI_PING_MS || 15000);
/** 本进程启动时刻，随心跳上报；Worker 据此判断「agent 重启过 → 在跑的命令丢了」。 */
const EPOCH = Date.now();

const KEY_FILE = join(homedir(), ".config", "watch-ai", "agent-key");
/** 本机身份文件（内容 = codespace 名）；没有就不发 X-Agent-Id。 */
const ID_FILE = join(homedir(), ".config", "watch-ai", "agent-id");
const LOG_FILE = join(homedir(), ".cache", "watch-ai-shell", "agent.log");

function resolveKey() {
  const fromEnv = (process.env.WATCH_AI_AGENT_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * 本机身份（发给 Worker 的 X-Agent-Id）。
 * 用于把「密钥」和「这台开发机」绑在一起：密钥一旦泄漏，别的机器拿它连上来
 * 也会因为 identity 不符被 Worker 拒掉（Worker 侧配了 AGENT_ID 才强制）。
 */
function resolveAgentId() {
  const fromEnv = (process.env.WATCH_AI_AGENT_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(ID_FILE)) return readFileSync(ID_FILE, "utf8").trim();
  } catch {
    /* ignore */
  }
  return "";
}

// ------------------------------------------------------------------ 签名 / 验签
//
// 与 Worker 的 src/agent-auth.ts 必须逐字节一致：
//   请求  v1\n<ts>\n<nonce>\n<METHOD>\n<path>\n<sha256(body)>
//   命令  v1\n<id>\n<cmd>
//
// 密钥只用来算签名，**不再随请求发送**——以前那个 X-Agent-Key 头等于每一次
// 请求都把密钥明文写一遍，落进任何一份日志就彻底泄漏了。

const AUTH_WINDOW_MS = 120_000;
/** Worker 未签名的命令是否执行。默认拒绝：只认签得上的命令。 */
const REQUIRE_SIG = (process.env.WATCH_AI_REQUIRE_SIG || "1") !== "0";

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const hmacHex = (msg) => createHmac("sha256", KEY).update(msg, "utf8").digest("hex");

/** 定长比较，避免因为提前 return 泄漏「前几位是否相同」。 */
function sigEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function commandInput(id, cmd) {
  return `v1\n${id}\n${cmd}`;
}

/** 生成一套上行签名头（每次请求都是新的 ts + nonce，故每条请求都重算）。 */
function authHeaders(method, path, bodyText) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const input = `v1\n${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${sha256Hex(bodyText)}`;
  const headers = {
    "X-Agent-Sig": hmacHex(input),
    "X-Agent-Ts": ts,
    "X-Agent-Nonce": nonce,
  };
  if (AGENT_ID) headers["X-Agent-Id"] = AGENT_ID;
  return headers;
}

/** 下行命令验签：签名对不上就绝不执行。 */
function cmdTrusted(sig, id, cmd) {
  if (!sig) {
    log(`拒绝未签名命令 ${id}${REQUIRE_SIG ? "（已强制验签）" : ""}`);
    return !REQUIRE_SIG;
  }
  const ok = sigEq(sig, hmacHex(commandInput(id, cmd)));
  if (!ok) log(`拒绝签名不符的命令 ${id}`);
  return ok;
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* 日志写不了就算了，不能因此崩掉 */
  }
  // 不要再 console.log：supervise.sh 已把 stdout 重定向到同一个 agent.log，
  // 两边都写会让每行日志出现两次，排障时很迷惑。
}

// ------------------------------------------------------------------ 输出清洗

const ESC = String.fromCharCode(27);

/** 去掉 ANSI 转义序列（CSI / OSC / 两字节序列），PTY 输出的必要清洗。 */
function stripAnsi(s) {
  return s
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g"), "")
    .replace(new RegExp(`${ESC}\\][^${ESC}\\x07]*(\\x07|${ESC}\\\\)`, "g"), "")
    .replace(new RegExp(`${ESC}[()][0-9A-Za-z]`, "g"), "")
    .replace(new RegExp(`${ESC}[=>]`, "g"), "")
    .replace(new RegExp(`${ESC}.`, "g"), "");
}

/** 归一化：去 ANSI、CR/LF 统一、行尾空白裁掉。 */
function sanitize(raw) {
  return stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n");
}

// 收尾 marker：单行同时带 exit code 和 cwd（合并成一行，避免两条 marker 的时序问题）
const RE_MARKER = /^__WS__(-?\d+)__(.*)__$/;

// ------------------------------------------------------------------ 状态

let child = null;
let ptyMode = "none";
let partial = ""; // 还没凑满一行的残留（PTY 按块写，行会被切断）
let buf = []; // 已凑满、待回传的行
let running = null; // { id, cmd, cwd, sentChars, truncated, stallNotified }
let flushTimer = null;
let stallTimer = null;
let cwd = process.env.HOME || "/";
/** 当前命令最后一次吐字节的时刻（0 = 没有在跑的命令）；看门狗据此判卡死 */
let lastOutputAt = 0;
/** bash 世代号：重启后递增，让旧实例的 exit 回调失效，避免叠出两个 bash */
let shellGen = 0;
let wedgeTimer = null;

// ------------------------------------------------------------ 进程探针状态
/** 最近一次探针结果（5 秒一探，心跳直接复用，不必每次都读 /proc） */
let lastProbe = null;
/** 按 pid 记录「上次见到的 CPU 累计」，用来判断这条命令到底还在不在动 */
let cpuSeen = new Map();
/** 第一次探测只记基线，不算「动过」——否则 wrapper 的启动 CPU 会被当成进度 */
let cpuPrimed = false;
/** 这条命令的 CPU 有没有真的增长过 */
let cpuGrew = false;
/** CPU 最后一次增长的时刻（cpuFrozenMs = now - cpuMaxAt） */
let cpuMaxAt = 0;

function resetProcState(now = Date.now()) {
  lastProbe = null;
  cpuSeen = new Map();
  cpuPrimed = false;
  cpuGrew = false;
  cpuMaxAt = now;
}

// ------------------------------------------------------------------ 持久 bash

function hasBin(name) {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${name} >/dev/null 2>&1`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * spawn 一个长驻交互 bash，三级降级：
 *   ① script（util-linux）——分配真 PTY，sudo / vim / 进度条这类交互程序才正常
 *   ② python3 pty 模块——同样是 PTY，用于没有 script 的镜像
 *   ③ 管道 stdio——保底：命令能跑，交互程序会退化
 * detached=true 让子进程自成进程组，退出时才能一次性杀干净不留孤儿。
 */
function spawnShell() {
  if (hasBin("script")) {
    ptyMode = "script";
    return spawn("script", ["-q", "-f", "-c", "/bin/bash -i", "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, TERM: "dumb" },
    });
  }
  if (hasBin("python3")) {
    ptyMode = "python-pty";
    return spawn("python3", ["-u", "-c", "import pty,sys;pty.spawn(['/bin/bash','-i'])"], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, TERM: "dumb" },
    });
  }
  ptyMode = "pipe";
  return spawn("/bin/bash", ["-i"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, TERM: "dumb" },
  });
}

function startShell() {
  const gen = ++shellGen;
  const c = spawnShell();
  child = c;
  log(`bash 已启动（pty=${ptyMode}, pid=${c.pid}, gen=${gen}）`);

  c.stdout.on("data", (d) => onShellData(d.toString("utf8")));
  c.stderr.on("data", (d) => onShellData(d.toString("utf8")));
  c.on("exit", (code, sig) => {
    // 被 restartShell 换掉的老实例：不能再碰全局状态，否则会把新 bash 的引用抹掉、
    // 并多排一次 startShell（结果同时跑两个 bash，抢同一条 stdin）。
    if (gen !== shellGen) {
      log(`旧 bash 退出（gen=${gen}, code=${code} sig=${sig}），已忽略`);
      return;
    }
    log(`bash 退出（code=${code} sig=${sig}）→ 3 秒后重启`);
    child = null;
    running = null;
    lastOutputAt = 0;
    setTimeout(startShell, 3000);
  });
  c.on("error", (e) => log(`bash spawn 失败：${e.message}`));
  // bash 已经死掉时往 stdin 写会抛 EPIPE。如果不吞掉，Node 会把它升级成
  // 未捕获的 'error' 事件 → 整个 agent 进程直接崩（实测 macOS 上 script 参数
  // 不兼容时就是这条路）。supervise 能拉起来，但会变成「起来→崩」的抖动循环。
  c.stdin.on("error", (e) => log(`bash stdin 出错：${e.code || e.message}`));

  // 关掉终端回显（否则每条命令会被原样再吐一遍）+ 清空提示符噪声。
  // PS2 必须一起清：多行命令（heredoc / if 块 / 子 shell）会打印续行提示符 "> "，
  // 每条都混进 Telegram 输出里，看起来像乱码。
  safeWrite("stty -echo 2>/dev/null\n");
  safeWrite("export PS1=''; export PS2=''; export PROMPT_COMMAND=''; export TERM=dumb\n");
  safeWrite(`cd ${JSON.stringify(WORKDIR)} 2>/dev/null || cd ~\n`);
  // Codespaces secret 并不是普通容器环境变量：它由 /etc/profile.d/codespaces.sh 在
  // 「登录 shell 且 $SSH_CONNECTION 非空」时才导出。agent 由 post-start.sh 拉起时那边会
  // 主动补一次；但被 supervisor 重启、或手动 setsid 拉起时，环境里就没有 GEMINI_API_KEY
  // → /gemini 会误报「还没有 API key」（2026-10-27 实际踩到）。
  // 这里在 bash 初始化时从 secret 源文件补一次：源头一致，且与启动方式解耦。
  // 已存在的值不覆盖（post-start 注入的优先）；read 不到就静默跳过。
  safeWrite(
    'for __n in GEMINI_API_KEY WATCH_AI_AGENT_KEY; do ' +
      '[ -n "$(printenv $__n 2>/dev/null)" ] && continue; ' +
      '__e=$(sed -n "s/^$__n=//p" /workspaces/.codespaces/shared/.env-secrets 2>/dev/null | head -1); ' +
      '[ -n "$__e" ] && export "$__n=$(printf %s "$__e" | base64 -d 2>/dev/null)"; ' +
      'unset __e; done 2>/dev/null; unset __n\n',
  );
}

/** 往 bash stdin 写一行，永远不抛（bash 死掉/管道断开都只是记日志）。 */
function safeWrite(s) {
  try {
    child?.stdin?.write(s);
    return true;
  } catch (e) {
    log(`写 bash 失败：${e.code || e.message}`);
    return false;
  }
}

/**
 * 强制换一个 bash（杀掉整个进程组后重启）。
 * 为什么杀进程组：spawn 时用了 detached，bash 和它下面的前台命令同属一个 pgid，
 * 只杀 bash 会留下孤儿子进程继续占着 PTY，新 bash 起来照样卡。
 */
function restartShell(reason) {
  log(`重启 bash（${reason}）`);
  const old = child;
  child = null;
  shellGen++; // 让旧实例的 exit 回调立刻失效，避免和新实例叠在一起
  if (old?.pid) {
    try {
      process.kill(-old.pid, "SIGKILL");
    } catch {
      try {
        process.kill(old.pid, "SIGKILL");
      } catch {
        /* 已经没了 */
      }
    }
  }
  setTimeout(startShell, 800);
}

// ------------------------------------------------------------------ 回传

function postOut(payload) {
  const body = JSON.stringify(payload);
  return fetch(`${WORKER}/shell/out`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders("POST", "/shell/out", body) },
    body,
  })
    .then((r) => {
      if (!r.ok) log(`回传被拒：HTTP ${r.status}`);
      return r.text().catch(() => "");
    })
    .catch((e) => log(`回传失败：${e.message}`));
}

/** 心跳：告诉 Worker「我活着，此刻在跑的是哪条命令」（Worker 侧的在线判定只看这个）。 */
function postPing() {
  // proc：在跑的那条命令此刻的进程状态（一行人话）。Worker 拿它回答
  // 「到底是在等、被挂起了、还是已经死了」—— 这是 /cs 和进度播报的数据源。
  const body = JSON.stringify({
    epoch: EPOCH,
    gen: shellGen,
    running: running ? running.id : null,
    proc: running && lastProbe?.tree ? stateLine(lastProbe.tree) : null,
  });
  return fetch(`${WORKER}/shell/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders("POST", "/shell/ping", body) },
    body,
  }).catch((e) => log(`心跳失败：${e.message}`));
}

function startPing() {
  setInterval(() => void postPing(), PING_MS);
  void postPing(); // 立刻报一次，别让 Worker 等满一个间隔才敢放行命令
}

function clearTimers() {
  if (flushTimer) clearTimeout(flushTimer);
  if (stallTimer) clearTimeout(stallTimer);
  flushTimer = null;
  stallTimer = null;
}

/** 推一条增量输出（静默窗口到期 / 长命令跑太久时） */
function flushIncremental() {
  if (!running) return;
  const text = buf.join("");
  buf = [];
  if (text) void postOut({ id: running.id, text, done: false });
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushIncremental, FLUSH_MS);
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (running && !running.stallNotified) {
      running.stallNotified = true;
      // 带上进程状态：这样「在跑」不是一句空话——能看出是在等网络还是已经冻住
      probeNow();
      buf.push(`⏳ 命令仍在运行（${Math.round(STALL_MS / 1000)} 秒无新输出）…${procSuffix()}\n`);
      flushIncremental();
    }
  }, STALL_MS);
}

/** marker 到齐 → 收尾回传（附 exit code + 执行后的 cwd） */
function finish(exit) {
  clearTimers();
  const r = running;
  running = null;
  lastOutputAt = 0;
  resetProcState();
  if (!r) return;
  let text = buf.join("") + partial;
  buf = [];
  partial = "";
  text = text.replace(/\n+$/, "");
  if (r.truncated) text += "\n…输出过长，已截断";
  cwd = r.cwd || cwd;
  void postOut({ id: r.id, text, done: true, exit, cwd: r.cwd || null });
  log(`done: exit=${exit} cwd=${r.cwd || ""} chars=${r.sentChars}`);
}

/** 读一次进程树并缓存。root = 长驻 bash（或它的 pty wrapper）的 pid。 */
function probeNow() {
  if (!child?.pid) {
    lastProbe = null;
    return null;
  }
  const tree = probeTree(child.pid);
  lastProbe = tree ? { at: Date.now(), tree } : null;
  return tree;
}

/** 进程状态一行（给「仍在运行」提示和心跳共用）。读不到就返回空串。 */
function procSuffix() {
  const t = lastProbe?.tree;
  return t ? ` · ${stateLine(t)}` : "";
}

/**
 * 更新 CPU 轨迹。
 *
 * 逐 pid 比较而不是比较整棵树的 CPU 之和：子进程会退出（它的 CPU 从总和里消失），
 * 新进程会加入（总和跳变），只看总和会误判成「冻住」或「一直在动」。
 */
function trackCpu(tree, now) {
  if (!tree) return;
  if (!cpuPrimed) {
    // 首次探测：只记基线。否则 wrapper/bash 的启动 CPU 会被当成这条命令的进度，
    // 「从没动过」这个判据就永远不成立 —— 那正是 2026-10-27 事故的形态。
    cpuPrimed = true;
    cpuSeen = new Map(tree.all.map((p) => [p.pid, p.cpuMs]));
    cpuMaxAt = now;
    cpuGrew = false;
    return;
  }
  let moved = false;
  const next = new Map();
  for (const p of tree.all) {
    const prev = cpuSeen.get(p.pid);
    if (prev === undefined) {
      if (p.cpuMs > 0) moved = true; // 新进程且已经烧过 CPU
    } else if (p.cpuMs > prev + 20) {
      moved = true; // 20ms 容差：时钟节拍是 10ms，抖动不算动
    }
    next.set(p.pid, Math.max(prev ?? 0, p.cpuMs));
  }
  cpuSeen = next;
  if (moved) {
    cpuGrew = true;
    cpuMaxAt = now;
  }
}

/**
 * 判定卡死后的强制回收：
 *   ① 立刻给 Worker 回一条 done(exit=124)，把队列放出来（这是用户能继续用的关键，
 *      否则要等 Worker 那边 45 分钟的 TTL）；
 *   ② 把已经收到的输出一起捎上，别让用户白等；
 *   ③ 换一个干净的 bash。
 */
function reclaimWedge(note, idle) {
  const r = running;
  if (!r) return;
  log(`看门狗：${note} → 回收命令 ${r.id}（已 ${Math.round(idle / 1000)}s 无输出）`);
  running = null;
  lastOutputAt = 0;
  clearTimers();

  let text = (buf.join("") + partial).replace(/\n+$/, "");
  buf = [];
  partial = "";
  if (text) text += "\n\n";
  text +=
    `⚠️ ${note}（${fmtDur(idle)}无输出）。\n` +
    `已强制中断这条命令并重启 bash —— 之前 cd / export 的 shell 状态没了，重发一次即可。`;
  void postOut({ id: r.id, text, done: true, exit: 124, cwd: null });
  restartShell("命令卡死");
}

/**
 * 「命令其实已经跑完了，只是收尾标记没回来」。
 * 这种情况 bash 是健康的，所以只收尾、不重启 —— 重启会把 shell 状态白白丢掉。
 */
function finishGone(note, idle) {
  const r = running;
  if (!r) return;
  log(`看门狗：${note} → 收尾命令 ${r.id}（已 ${Math.round(idle / 1000)}s 无输出）`);
  running = null;
  lastOutputAt = 0;
  clearTimers();

  let text = (buf.join("") + partial).replace(/\n+$/, "");
  buf = [];
  partial = "";
  if (text) text += "\n\n";
  text += `ℹ️ ${note}（${fmtDur(idle)}无输出），已按结束处理。`;
  void postOut({ id: r.id, text, done: true, exit: null, cwd: null });
}

/** 只报一次的异常（被挂起 / 卡 IO）—— 不自动杀，交给人决定。 */
function noteOnce(r, note) {
  if (r.noted === note) return;
  r.noted = note;
  buf.push(`⚠️ ${note} —— 不会自动中断，/ctrlc 可以打断。\n`);
  flushIncremental();
}

/** 长任务周期性播报：告诉用户「还在跑、进程是什么状态」，而不是让他干等。 */
function maybeReportProgress(r, idle, now) {
  if (idle < PROGRESS_MS) return;
  if (r.progressAt && now - r.progressAt < PROGRESS_REPEAT_MS) return;
  r.progressAt = now;
  buf.push(`⏳ 仍在运行（${fmtDur(idle)}无新输出）${procSuffix()}\n`);
  flushIncremental();
}

/**
 * 看门狗：每 5 秒看一次「有命令在跑但长时间零字节输出」该怎么处理。
 *
 * 这一版的关键变化：**不再只看「有没有输出」**。codebuddy / gemini 接了大活时
 * 连续几分钟不吐字节是常态，旧逻辑（4 分钟零输出 = 卡死）会把它们直接 SIGKILL，
 * 整个进程组一起没 —— 正在写的文件可能只写一半。现在先看进程证据再决定：
 *
 *   gone         命令的进程全没了（bash 还好好的）→ 其实跑完了，只收尾不重启
 *   zombie       进程已是僵尸                    → 回收
 *   never-moved  一次 CPU 都没动过且静默 10 分钟  → 回收（2026-10-27 事故形态）
 *   cpu-frozen   动过但 CPU 冻住 15 分钟          → 回收
 *   suspended    SIGSTOP / 被调试器停住           → 只报，不杀
 *   io           卡在不可中断 IO                  → 只报，不杀
 *   waiting      其余                            → 继续等，周期性播报进度
 *
 * 读不到 /proc（非 Linux）时退回旧的纯时间判据，绝不把「读不到」当成「卡死」。
 */
function startWedgeWatchdog() {
  if (wedgeTimer) clearInterval(wedgeTimer);
  wedgeTimer = setInterval(() => {
    const now = Date.now();
    const tree = probeNow();
    if (!running || !lastOutputAt) return;
    const r = running;
    const idle = now - lastOutputAt;
    trackCpu(tree, now);

    if (!tree) {
      if (!procAvailable()) {
        // 非 Linux：没有进程证据，退回纯时间兜底（旧行为）
        const limit = r.everOutput ? WEDGE_MS * 2 : WEDGE_MS;
        if (idle >= limit) reclaimWedge(`${Math.round(limit / 1000)} 秒没有任何输出，判定卡死`, idle);
      }
      // 有 /proc 但探不到树 = bash 没了 → exit 回调会处理，这里不动
      return;
    }

    const j = judgeIdle({
      tree,
      idleMs: idle,
      cpuGrew,
      cpuFrozenMs: now - cpuMaxAt,
      wedgeMs: NEVER_MOVED_MS,
      stuckMs: STUCK_MS,
      goneIdleMs: 15_000,
    });

    if (j.kill) {
      reclaimWedge(j.note, idle);
      return;
    }
    if (j.verdict === "gone") {
      finishGone(j.note, idle);
      return;
    }
    if (j.verdict === "suspended" || j.verdict === "io") {
      noteOnce(r, j.note);
      return;
    }
    maybeReportProgress(r, idle, now);
  }, 5000);
}

// ------------------------------------------------------------------ 输出解析

function onShellData(raw) {
  const clean = sanitize(raw);
  if (!clean) return;
  // 只要 bash 还吐字节，就说明它没死（哪怕只是一行空提示），看门狗重新计时
  if (running) {
    lastOutputAt = Date.now();
    running.everOutput = true;
  }
  partial += clean;

  let idx;
  while ((idx = partial.indexOf("\n")) >= 0) {
    const line = partial.slice(0, idx);
    partial = partial.slice(idx + 1);

    const mMarker = RE_MARKER.exec(line.trim());
    if (mMarker) {
      if (running) running.cwd = mMarker[2];
      else cwd = mMarker[2];
      finish(Number(mMarker[1]));
      continue;
    }
    // 回显兜底：命令本身被 PTY 回显时，首行重复则丢弃（stty 失效的场景）
    if (running && buf.length === 0 && line.trim() === running.cmd.trim()) continue;

    if (!running) continue; // 命令间隙的输出（后台 job 吐的）暂不回传

    if (running.sentChars + line.length + 1 > MAX_CHARS) {
      running.truncated = true;
      continue;
    }
    running.sentChars += line.length + 1;
    buf.push(line + "\n");
    scheduleFlush();
  }
}

function runCommand(id, cmd, quiet = false) {
  // 幂等：Worker 会在「ack 超时」时重发同一条命令，重发不是新请求。
  // 重复执行会毁掉幂等性（写文件 / 提交 / 扣额度），所以直接忽略。
  if (running && running.id === id) return;
  if (!child) {
    void postOut({ id, done: true, exit: null, cwd: null, text: "⚠️ bash 未就绪，稍等几秒重试" });
    return;
  }
  if (running) {
    void postOut({ id, done: true, exit: null, cwd: null, text: "⚠️ 上一条命令还在跑，先 /ctrlc 中断" });
    return;
  }
  // 签收：让 Worker 知道这条命令**真的到了**（不是写进了一条死连接）。
  void postOut({ id, ack: true });
  running = {
    id,
    cmd,
    cwd: null,
    sentChars: 0,
    truncated: false,
    stallNotified: false,
    everOutput: false,
    progressAt: 0,
    noted: null,
  };
  buf = [];
  partial = "";
  lastOutputAt = Date.now(); // 看门狗从下发这一刻开始计时
  resetProcState(lastOutputAt); // CPU 轨迹从这一刻起算，别把上一条的当成进度
  // quiet：命令原文含密钥（如 /gemini key），只记长度不记内容
  log(quiet ? `exec: [hidden ${cmd.length} chars]` : `exec: ${cmd.replace(/\n/g, " ; ")}`);

  if (!safeWrite(cmd + "\n")) {
    // 写不进去 = bash 死了。立刻收尾，别让 Worker 那边白等 45 分钟 TTL。
    finish(null);
    return;
  }
  // 收尾 marker：单行同时回 exit code 和执行后的 cwd（cd 才能跨消息生效）
  safeWrite(`__r=$?; printf '\\n__WS__%s__%s__\\n' "$__r" "$PWD"; unset __r\n`);
  scheduleFlush();
}

function sendCtrlC() {
  if (!safeWrite("\x03")) log("Ctrl-C 发送失败（bash 不可写）");
}

// ------------------------------------------------------------------ SSE 订阅

function handleEvent(ev) {
  if (ev?.t === "cmd") {
    if (!cmdTrusted(ev.sig, ev.id, ev.cmd)) return;
    runCommand(ev.id, ev.cmd, ev.q === 1);
    return;
  }
  if (ev?.t === "ctrlc") {
    // 控制帧同样要验签：不然谁都能反复打断你正在跑的构建
    if (REQUIRE_SIG && !(ev.sig && sigEq(ev.sig, hmacHex(commandInput("__ctrlc__", ""))))) {
      log("拒绝未签名/签名不符的 ctrlc");
      return;
    }
    sendCtrlC();
  }
}

async function subscribe(signal) {
  const res = await fetch(`${WORKER}/shell/stream`, {
    headers: { Accept: "text/event-stream", ...authHeaders("GET", "/shell/stream", "") },
    signal,
  });
  if (!res.ok) {
    // 401 = 签名/密钥不对。这种情况重连再快也没用，日志里必须写清楚原因，
    // 否则现场只会看到「一直连不上」而不知道怎么修。
    const why = res.status === 401 ? "鉴权失败（密钥或签名不匹配，检查 AGENT_KEY）" : `HTTP ${res.status}`;
    throw new Error(`SSE ${why}`);
  }
  log("SSE 已连接（HMAC 签名已启用）");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let s = "";
  let lastAt = Date.now();

  // 静默 watchdog：Worker 每 20s 一次心跳，超过 SILENCE_MS 没字节就当死连接
  const wd = setInterval(() => {
    if (Date.now() - lastAt > SILENCE_MS) {
      log("SSE 静默超时 → 重连");
      void reader.cancel().catch(() => {});
    }
  }, 10_000);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastAt = Date.now();
      s += dec.decode(value, { stream: true });
      let i;
      while ((i = s.indexOf("\n\n")) >= 0) {
        const ev = s.slice(0, i);
        s = s.slice(i + 2);
        for (const line of ev.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            handleEvent(JSON.parse(line.slice(6)));
          } catch {
            /* 坏包忽略 */
          }
        }
      }
    }
  } finally {
    clearInterval(wd);
  }
}

// ------------------------------------------------------------------ main

const KEY = resolveKey();
const AGENT_ID = resolveAgentId();

async function main() {
  if (!KEY) {
    log(
      `缺少密钥：设置环境变量 WATCH_AI_AGENT_KEY，或写入 ${KEY_FILE}` +
        `（值需与 Worker 的 AGENT_KEY secret 一致）`,
    );
    process.exit(1);
  }
  if (KEY.length < 32) {
    // 短密钥对 HMAC 来说等于没有：一秒几万次的离线爆破就能试出来
    log(`密钥过短（${KEY.length} 字符）→ 拒绝启动。请用 ≥32 字符的随机串（openssl rand -hex 32）`);
    process.exit(1);
  }
  if (!WORKER.startsWith("https://") && !WORKER_IS_LOCAL) {
    log(`Worker 地址必须是 https：${WORKER}`);
    process.exit(1);
  }
  log(`启动：worker=${WORKER} id=${AGENT_ID || "(未设置)"} 验签=${REQUIRE_SIG ? "强制" : "宽松"}`);

  mkdirSync(dirname(LOG_FILE), { recursive: true });
  startShell();
  startWedgeWatchdog();
  startPing();

  let backoff = 1000;
  for (;;) {
    const ac = new AbortController();
    try {
      // eslint-disable-next-line no-await-in-loop
      await subscribe(ac.signal);
      backoff = 1000; // 心跳超时导致的正常断开 → 立刻重连
    } catch (e) {
      log(`SSE 出错：${e.message} → ${backoff}ms 后重连`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

// 退出时把整个 bash 进程组带走，别留孤儿
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`收到 ${sig}，退出`);
    try {
      if (child?.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}

main();
