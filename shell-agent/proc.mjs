/**
 * 进程探针：从 /proc 读出「这条命令的进程树现在到底在干什么」。
 *
 * 为什么单独拆一个文件：agent.mjs 一被 import 就会连 SSE、spawn bash，
 * 没法在测试里单独跑；把这几个纯函数拆出来就能用 node 直接断言
 * （见 proc.test.mjs，用真实的 sleep 进程树验证，不靠 mock）。
 *
 * 只在 Linux 上有效；没有 /proc 时 probeTree 返回 null，调用方退回
 * 「只看输出」的旧判据 —— 绝不能把「读不到」当成「卡死」。
 */

import { existsSync, readFileSync } from "node:fs";

/** /proc/<pid>/stat 里 state 字段的人类解释（agent 直接拿去拼提示语）。 */
export const STATE_LABEL = {
  R: "运行中",
  S: "睡眠（等 IO/网络，正常）",
  D: "不可中断（卡在内核/磁盘）",
  T: "被挂起（SIGSTOP）",
  t: "被调试器暂停",
  Z: "僵尸（已死，父进程没收尸）",
  I: "空闲内核线程",
  X: "已死",
};

/** 这台机器有没有 /proc（macOS 本地调试时为 false）。 */
export function procAvailable() {
  return existsSync("/proc/self/stat");
}

/** 认得出 shell 名字，才能在 pty 包装器下面找到「真正的 bash」。 */
const SHELL_NAMES = /^(bash|sh|dash|zsh|fish|ksh)$/;

/**
 * 读一个进程的 stat。进程已退出 / 没权限返回 null（这是常态，不是错误）。
 *
 * comm 在括号里且可能含空格和括号（`(node)`、`(a b)`），所以必须从**最后一个**
 * `)` 之后开始切字段，不能按空格 split 整行 —— 否则 comm 里带空格时字段全错位。
 */
export function readProcStat(pid, clkTick = 100) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const lp = s.indexOf("(");
    const rp = s.lastIndexOf(")");
    if (lp < 0 || rp < lp) return null;
    const comm = s.slice(lp + 1, rp);
    const f = s.slice(rp + 2).trim().split(/\s+/);
    // f[0]=state(3) f[1]=ppid(4) f[11]=utime(14) f[12]=stime(15)
    const ticks = (Number(f[11]) || 0) + (Number(f[12]) || 0);
    return {
      pid,
      comm,
      state: f[0] || "?",
      ppid: Number(f[1]) || 0,
      cpuMs: Math.round((ticks * 1000) / (clkTick || 100)),
    };
  } catch {
    return null;
  }
}

/** 某个 pid 的直接子进程。用 children 文件，不 fork（每 5 秒调一次）。 */
export function childrenOf(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return s ? s.split(/\s+/).map(Number).filter((n) => n > 0) : [];
  } catch {
    return [];
  }
}

/**
 * 探从 rootPid 往下的进程树，并把「shell 本身」和「命令本身的进程」分开。
 *
 * 结构取决于 agent 起的 pty 模式：
 *   script 模式   agent → script → bash → 命令…
 *   pipe 模式     agent → bash → 命令…
 *   exec 模式     agent → 命令本身（bash -c 对简单命令会直接 exec 掉自己，
 *                 这时 root.comm 就是 sleep/npm，下面一个子进程都没有）
 * 所以先认出 shell 那一层（认名字，不认 CPU），cmd = shell 下面所有后代；
 * 认不出 shell 时说明 root 自己就是命令，cmd = root + 它的后代。
 */
export function probeTree(rootPid, opts = {}) {
  if (!procAvailable()) return null;
  const clkTick = opts.clkTick || 100;
  const root = readProcStat(rootPid, clkTick);
  if (!root) return null;

  // shell 那一层：root 自己就是 shell 时直接用；否则在它的子进程里找。
  let shell = SHELL_NAMES.test(root.comm) ? root : null;
  if (!shell) {
    for (const k of childrenOf(rootPid)) {
      const st = readProcStat(k, clkTick);
      if (st && SHELL_NAMES.test(st.comm)) {
        shell = st;
        break;
      }
    }
  }

  const cmd = [];
  const seen = new Set([root.pid]);
  const walk = (pid, depth) => {
    if (depth > 3) return;
    for (const c of childrenOf(pid)) {
      if (seen.has(c)) continue;
      seen.add(c);
      const st = readProcStat(c, clkTick);
      if (st) {
        cmd.push(st);
        walk(c, depth + 1);
      }
    }
  };
  if (shell) {
    walk(shell.pid, 0);
  } else {
    // 没有 shell 层：root 就是命令本体（`bash -c 'sleep 300'` 的 exec 形态）
    cmd.push(root);
    walk(root.pid, 0);
  }
  const bash = shell ?? root;

  // 「最忙的那个」= 真正在干活/在等的那层（bash 的 CPU 通常不是最高）
  const sorted = [...cmd].sort((a, b) => b.cpuMs - a.cpuMs);
  const leaf = sorted[0] ?? bash;
  let wchan = "";
  if (leaf.pid !== bash.pid) {
    try {
      const w = readFileSync(`/proc/${leaf.pid}/wchan`, "utf8").trim();
      if (w && w !== "0") wchan = w;
    } catch {
      /* 进程刚退出 / 无权限 */
    }
  }

  const all = [root, bash, ...cmd];
  return {
    root,
    bash,
    cmd,
    all,
    leaf,
    wchan,
    /** 全树 CPU 累计（毫秒）——用来判断「还在动」还是「冻住了」 */
    cpuMs: all.reduce((a, p) => a + p.cpuMs, 0),
  };
}

/** 4 分 12 秒 / 12 秒 / 0 秒 */
export function fmtDur(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/** 3.4s / 812ms */
export function fmtCpu(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(ms))}ms`;
}

/**
 * 一行进程状态，给「仍在运行」提示和 /cs 共用。
 * 例：`codebuddy[8341] S 睡眠（等 IO/网络，正常）· 等 ep_poll · CPU 3.4s`
 */
export function stateLine(tree) {
  if (!tree) return "进程状态不可用（没有 /proc）";
  const p = tree.leaf;
  const n = tree.cmd.length;
  const multi = n > 1 ? `${n} 个进程 · ` : "";
  const label = STATE_LABEL[p.state] ?? "未知状态";
  const wait = tree.wchan ? ` · 等 ${tree.wchan}` : "";
  return `${multi}${p.comm}[${p.pid}] ${p.state} ${label}${wait} · CPU ${fmtCpu(p.cpuMs)}`;
}

/**
 * 判定「该不该杀」。
 *
 * 这是这一版的核心：以前只看「有没有输出」，于是把「正常在思考」当成「卡死」。
 * 现在先看进程本身 —— 只有这四种证据成立才动手：
 *   zombie     进程已经是僵尸（死透了，只是没人收尸）
 *   never-moved CPU 一个 tick 都没跑过、也没有输出超过 wedgeMs（卡在等输入/启动）
 *   cpu-frozen  曾经动过，但 CPU 完全冻住超过 stuckMs（真挂死）
 * 而 `T`（被挂起）和 `D`（卡 IO）只**报**不杀：前者人一恢复就继续，后者多半自己出来。
 *
 * 返回值：{ verdict, kill, note }
 *   verdict: gone | zombie | never-moved | cpu-frozen | suspended | io | waiting
 */
export function judgeIdle(input) {
  const {
    tree,
    idleMs = 0,
    cpuGrew = false,
    cpuFrozenMs = 0,
    wedgeMs = 240000,
    stuckMs = 900000,
    goneIdleMs = 15000,
  } = input;

  if (!tree) return { verdict: "waiting", kill: false, note: "" };

  // ① 命令的进程已经全没了，但 bash 还活着 → 其实结束了，只是收尾 marker 丢了。
  //    给 15 秒缓冲：短命令（cd / export）的进程会瞬间消失，那时 marker 马上就到。
  if (tree.cmd.length === 0) {
    if (idleMs > goneIdleMs) return { verdict: "gone", kill: false, note: "命令的进程已全部退出" };
    return { verdict: "waiting", kill: false, note: "" };
  }

  const states = tree.cmd.map((p) => p.state);

  // ② 僵尸：已经死了，等谁收尸都不会有输出
  if (states.includes("Z")) return { verdict: "zombie", kill: true, note: "进程已是僵尸" };

  // ③ 被 SIGSTOP / 调试器停住：不会自己结束，但也不该由我们杀 —— 报出来让人决定
  if (states.includes("T") || states.includes("t")) {
    return { verdict: "suspended", kill: false, note: "进程被挂起（SIGSTOP / 终端停住）" };
  }

  // ④ 卡在内核 IO：多半会自己出来，超过 2 分钟就提一句，不杀
  if (states.includes("D") && idleMs > 120000) {
    return { verdict: "io", kill: false, note: "进程卡在不可中断 IO" };
  }

  // ⑤ 从来没动过 CPU：卡在等输入 / 启动失败，这是历史事故的形态
  if (!cpuGrew && idleMs > wedgeMs) {
    return { verdict: "never-moved", kill: true, note: `CPU 一次都没动过、已 ${fmtDur(idleMs)} 无输出` };
  }

  // ⑥ 动过，但完全冻住了
  if (cpuGrew && cpuFrozenMs > stuckMs) {
    return { verdict: "cpu-frozen", kill: true, note: `CPU 已冻住 ${fmtDur(cpuFrozenMs)}` };
  }

  return { verdict: "waiting", kill: false, note: "" };
}
