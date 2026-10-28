/**
 * proc.mjs 的实测（不是 mock）：真的 spawn 进程、真的 SIGSTOP、真的读 /proc。
 * 只能在 Linux 上跑（codespace / CI）：
 *   node shell-agent/proc.test.mjs
 *
 * 为什么值得单独测：这一版的核心判断（杀不杀）全靠 state / CPU 变化，
 * 拿假数据测等于没测 —— 改错字段下标就会把「在跑」判成「卡死」。
 */

import { spawn } from "node:child_process";
import {
  procAvailable,
  probeTree,
  judgeIdle,
  stateLine,
  fmtDur,
  fmtCpu,
  readProcStat,
} from "./proc.mjs";

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个 `bash -c <script>`，返回句柄（自带清理）。 */
function spawnBash(script) {
  const p = spawn("/bin/bash", ["-c", script], { stdio: "ignore", detached: true });
  return p;
}

async function main() {
  if (!procAvailable()) {
    console.log("/proc 不可用（非 Linux），跳过。");
    return;
  }
  console.log("== /proc 可用 ==");

  // ---------------------------------------------------------------- 格式
  check("fmtDur 4分12秒", fmtDur(252_000), "4 分 12 秒");
  check("fmtDur 12秒", fmtDur(12_400), "12 秒");
  check("fmtCpu 毫秒", fmtCpu(812), "812ms");
  check("fmtCpu 秒", fmtCpu(3400), "3.4s");

  // ---------------------------------------------------------------- 睡眠进程
  // 注意：不能用 `bash -c "sleep 300"` —— 简单命令时 bash 会直接 exec 掉自己，
  // 那就测不到「bash 下面挂着命令」的常见形态（exec 形态单独在下面测）。
  const sleeper = spawnBash("sleep 300; echo done");
  await sleep(400);
  let tree = probeTree(sleeper.pid);
  check("能探到树", tree !== null, true);
  check("认得出 bash", tree.bash.comm, "bash");
  check("命令进程只有 1 个", tree.cmd.length, 1);
  check("命令进程是 sleep", tree.cmd[0].comm, "sleep");
  check("sleep 状态 S", tree.cmd[0].state, "S");
  check("stateLine 含 pid", stateLine(tree).includes(`[${tree.cmd[0].pid}]`), true);
  check("stateLine 含 CPU", stateLine(tree).includes("CPU"), true);

  // 睡眠 300 秒 = 正常在等，绝不能判死
  const waiting = judgeIdle({
    tree,
    idleMs: 600_000,
    cpuGrew: true,
    cpuFrozenMs: 600_000,
    wedgeMs: 240_000,
    stuckMs: 900_000,
  });
  check("跑满 10 分钟但 CPU 冻住 10 分 < 15 分：不杀", waiting.verdict, "waiting");

  // ---------------------------------------------------------------- 被挂起
  process.kill(tree.cmd[0].pid, "SIGSTOP");
  await sleep(300);
  tree = probeTree(sleeper.pid);
  check("SIGSTOP 后状态 T", tree.cmd[0].state, "T");
  const suspended = judgeIdle({ tree, idleMs: 900_000, cpuGrew: true, cpuFrozenMs: 900_000 });
  check("被挂起 → 只报不杀", suspended.verdict, "suspended");
  check("被挂起 kill=false", suspended.kill, false);

  process.kill(tree.cmd[0].pid, "SIGCONT");
  await sleep(300);
  tree = probeTree(sleeper.pid);
  check("SIGCONT 后回到 S", tree.cmd[0].state, "S");

  // ---------------------------------------------------------------- 进程没了
  process.kill(-sleeper.pid, "SIGKILL");
  await sleep(400);
  tree = probeTree(sleeper.pid);
  check("进程树消失后 probeTree 为空", tree, null);
  // 直接喂一个「bash 还活着但没子进程」的树，验证 gone 判定
  const bare = { cmd: [], leaf: { pid: 1, comm: "bash", state: "S", cpuMs: 10 }, cpuMs: 10, all: [] };
  check("没有子进程且静默 20s → gone", judgeIdle({ tree: bare, idleMs: 20_000 }).verdict, "gone");
  check("没有子进程但只静默 1s → 还是 waiting", judgeIdle({ tree: bare, idleMs: 1_000 }).verdict, "waiting");

  // ---------------------------------------------------------------- CPU 在涨
  // 同上：while 循环是在 bash 自己进程里跑的（没有子进程），
  // 要测「子进程在烧 CPU」得用一个真正的外部命令。
  const burner = spawnBash("node -e 'while(1){}'");
  await sleep(900);
  const t1 = probeTree(burner.pid);
  await sleep(700);
  const t2 = probeTree(burner.pid);
  check("烧 CPU 的子进程状态 R", t2.cmd[0].state, "R");
  check("CPU 在增长", t2.cpuMs > t1.cpuMs, true);
  process.kill(-burner.pid, "SIGKILL");

  // ------------------------------------------------- exec 形态（bash 把自己换成命令）
  // `bash -c "sleep 300"` 没有子进程，root 自己就是 sleep。
  // 这是以前会误判成「命令已结束」的坑：cmd 必须包含 root 本身。
  const execd = spawnBash("sleep 300");
  await sleep(400);
  const ex = probeTree(execd.pid);
  check("exec 形态：探得到树", ex !== null, true);
  check("exec 形态：root 就是命令", ex.cmd.length, 1);
  check("exec 形态：进程名是 sleep", ex.cmd[0].comm, "sleep");
  check(
    "exec 形态：静默 10 分钟也不判 gone",
    judgeIdle({ tree: ex, idleMs: 600_000, cpuGrew: true, cpuFrozenMs: 600_000 }).verdict,
    "waiting",
  );
  process.kill(-execd.pid, "SIGKILL");

  // ---------------------------------------------------------------- 杀不杀
  const frozen = { cmd: [{ pid: 9, comm: "x", state: "S", cpuMs: 100 }], leaf: { pid: 9, comm: "x", state: "S", cpuMs: 100 }, cpuMs: 100, all: [] };
  check(
    "CPU 冻住 16 分钟 → 杀",
    judgeIdle({ tree: frozen, idleMs: 960_000, cpuGrew: true, cpuFrozenMs: 960_000 }).verdict,
    "cpu-frozen",
  );
  check(
    "CPU 从没动过 + 静默 5 分钟 → 杀",
    judgeIdle({ tree: frozen, idleMs: 300_000, cpuGrew: false, cpuFrozenMs: 300_000 }).verdict,
    "never-moved",
  );
  check(
    "CPU 从没动过但只静默 1 分钟 → 再等等",
    judgeIdle({ tree: frozen, idleMs: 60_000, cpuGrew: false, cpuFrozenMs: 60_000 }).verdict,
    "waiting",
  );
  const zombie = { cmd: [{ pid: 9, comm: "x", state: "Z", cpuMs: 100 }], leaf: { pid: 9, comm: "x", state: "Z", cpuMs: 100 }, cpuMs: 100, all: [] };
  check("僵尸 → 杀", judgeIdle({ tree: zombie, idleMs: 1000 }).kill, true);

  // ---------------------------------------------------------------- 生产形态：script → bash → 命令
  const wrapper = spawn("script", ["-q", "-f", "-c", "/bin/bash -i", "/dev/null"], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
    env: { ...process.env, TERM: "dumb" },
  });
  await sleep(600);
  wrapper.stdin.write("stty -echo 2>/dev/null; export PS1=''; export PS2=''\n");
  wrapper.stdin.write("sleep 300\n");
  await sleep(800);
  const prod = probeTree(wrapper.pid);
  check("script 包装：root 是 script", prod.root.comm, "script");
  check("script 包装：认得出 bash", prod.bash.comm, "bash");
  check("script 包装：cmd 里有 sleep", prod.cmd.some((p) => p.comm === "sleep"), true);
  check("script 包装：leaf 不是 bash", prod.leaf.pid !== prod.bash.pid, true);
  wrapper.stdin.write("exit\n");
  try {
    process.kill(-wrapper.pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }

  // ---------------------------------------------------------------- 收尾
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("测试异常：", e);
  process.exitCode = 1;
});
