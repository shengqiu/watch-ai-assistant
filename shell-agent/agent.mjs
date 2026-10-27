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
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ------------------------------------------------------------------ 配置

const WORKER = (
  process.env.WATCH_AI_WORKER || "https://watch-ai-devbot.shengqiu-purdue.workers.dev"
).replace(/\/+$/, "");

const WORKDIR = process.env.WATCH_AI_WORKDIR || "/workspaces/watch-ai-assistant";

/** 增量输出静默多久就推一条消息（毫秒） */
const FLUSH_MS = Number(process.env.WATCH_AI_FLUSH_MS || 1200);
/** 多久没有任何输出就提示「仍在运行」（不杀进程，只告知）。Gemini 思考常超 20s，故放宽。 */
const STALL_MS = Number(process.env.WATCH_AI_STALL_MS || 30000);
/** 单条命令最多回传多少字符（超出丢弃；Worker 端还有一层掐头尾） */
const MAX_CHARS = Number(process.env.WATCH_AI_MAX_CHARS || 60000);
/** 多久没收到 SSE 字节就当死连接重连（Worker 心跳 20s） */
const SILENCE_MS = Number(process.env.WATCH_AI_SILENCE_MS || 60000);

const KEY_FILE = join(homedir(), ".config", "watch-ai", "agent-key");
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
  child = spawnShell();
  log(`bash 已启动（pty=${ptyMode}, pid=${child.pid}）`);

  child.stdout.on("data", (d) => onShellData(d.toString("utf8")));
  child.stderr.on("data", (d) => onShellData(d.toString("utf8")));
  child.on("exit", (code, sig) => {
    log(`bash 退出（code=${code} sig=${sig}）→ 3 秒后重启`);
    child = null;
    running = null;
    setTimeout(startShell, 3000);
  });
  child.on("error", (e) => log(`bash spawn 失败：${e.message}`));

  // 关掉终端回显（否则每条命令会被原样再吐一遍）+ 清空提示符噪声。
  // PS2 必须一起清：多行命令（heredoc / if 块 / 子 shell）会打印续行提示符 "> "，
  // 每条都混进 Telegram 输出里，看起来像乱码。
  child.stdin.write("stty -echo 2>/dev/null\n");
  child.stdin.write("export PS1=''; export PS2=''; export PROMPT_COMMAND=''; export TERM=dumb\n");
  child.stdin.write(`cd ${JSON.stringify(WORKDIR)} 2>/dev/null || cd ~\n`);
}

// ------------------------------------------------------------------ 回传

function postOut(payload) {
  return fetch(`${WORKER}/shell/out`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Key": KEY },
    body: JSON.stringify(payload),
  })
    .then((r) => {
      if (!r.ok) log(`回传被拒：HTTP ${r.status}`);
      return r.text().catch(() => "");
    })
    .catch((e) => log(`回传失败：${e.message}`));
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
      buf.push("⏳ 命令仍在运行（20 秒无新输出）…\n");
      flushIncremental();
    }
  }, STALL_MS);
}

/** marker 到齐 → 收尾回传（附 exit code + 执行后的 cwd） */
function finish(exit) {
  clearTimers();
  const r = running;
  running = null;
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

// ------------------------------------------------------------------ 输出解析

function onShellData(raw) {
  const clean = sanitize(raw);
  if (!clean) return;
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
  if (!child) {
    void postOut({ id, done: true, exit: null, cwd: null, text: "⚠️ bash 未就绪，稍等几秒重试" });
    return;
  }
  if (running) {
    void postOut({ id, done: true, exit: null, cwd: null, text: "⚠️ 上一条命令还在跑，先 /ctrlc 中断" });
    return;
  }
  running = { id, cmd, cwd: null, sentChars: 0, truncated: false, stallNotified: false };
  buf = [];
  partial = "";
  // quiet：命令原文含密钥（如 /gemini key），只记长度不记内容
  log(quiet ? `exec: [hidden ${cmd.length} chars]` : `exec: ${cmd.replace(/\n/g, " ; ")}`);

  child.stdin.write(cmd + "\n");
  // 收尾 marker：单行同时回 exit code 和执行后的 cwd（cd 才能跨消息生效）
  child.stdin.write(`__r=$?; printf '\\n__WS__%s__%s__\\n' "$__r" "$PWD"; unset __r\n`);
  scheduleFlush();
}

function sendCtrlC() {
  try {
    child?.stdin?.write("\x03");
  } catch (e) {
    log(`Ctrl-C 发送失败：${e.message}`);
  }
}

// ------------------------------------------------------------------ SSE 订阅

function handleEvent(ev) {
  if (ev?.t === "cmd") runCommand(ev.id, ev.cmd, ev.q === 1);
  else if (ev?.t === "ctrlc") sendCtrlC();
}

async function subscribe(signal) {
  const res = await fetch(`${WORKER}/shell/stream`, {
    headers: { "X-Agent-Key": KEY, Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
  log("SSE 已连接");

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

async function main() {
  if (!KEY) {
    log(
      `缺少密钥：设置环境变量 WATCH_AI_AGENT_KEY，或写入 ${KEY_FILE}` +
        `（值需与 Worker 的 AGENT_KEY secret 一致）`,
    );
    process.exit(1);
  }

  mkdirSync(dirname(LOG_FILE), { recursive: true });
  startShell();

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
