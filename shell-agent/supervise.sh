#!/usr/bin/env bash
# shell-agent 守护进程：agent 退出（崩溃 / SSE 被踢 / OOM）后重起。
#
# 为什么需要它：codespace 内的 agent 是唯一能让 devbot 反向执行命令的通道，
# 它一旦静默死掉，Telegram 那边只会显示「shell 未连接」，很难排查。
# 用 supervisor 包一层，异常退出能自愈；codespace 本身被 stop 时整个容器
# 一起消失，不会留下孤儿进程。
#
# v2026-10-28 三处修复（当天两次「开机后 shell 通道不回来」的事故）：
#   1) pidfile 改由本脚本写自己的 pid。原先 post-start 里 `echo $! > pidfile`
#      记的是 setsid 那层壳的 pid，跟真实进程对不上 → 每次开机都误判「pidfile 残留」，
#      也让 `ps` 校验形同虚设。
#   2) 加 flock 单实例锁。原先 post-start 的兜底 pgrep 只要有一瞬没看到 agent
#      就会再拉一个 supervisor → 两个 agent 抢同一条 SSE，同一条命令被执行两次。
#   3) 秒退退避。node 不在 PATH / 密钥缺失时 agent 会 5 秒退一次，日志刷成瀑布；
#      现在「活不到 3 秒」改成 30 秒后再试，并写一行原因提示。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${HOME}/.cache/watch-ai-shell"
LOG="${LOG_DIR}/agent.log"
PIDFILE="${LOG_DIR}/agent.pid"
LOCK="${LOG_DIR}/supervise.lock"
mkdir -p "$LOG_DIR"

# postStart 不是登录 shell：nvm 装的 node 可能不在 PATH 里（agent 起不来最常见的原因）
export PATH="$HOME/nvm/current/bin:/usr/local/share/nvm/current/bin:$HOME/.local/bin:$PATH"

# 单实例：postStart、手动补跑、ssh 进去再跑一次，都不该叠出第二个 agent
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Is) 已有 supervisor 在跑（锁被占用），本实例退出" >>"$LOG"
  exit 0
fi

echo $$ >"$PIDFILE"

while true; do
  started=$(date +%s)
  echo "$(date -Is) supervisor($$) 启动 agent（node=$(command -v node || echo 未找到)）" >>"$LOG"
  node "$HERE/agent.mjs" >>"$LOG" 2>&1
  code=$?
  lived=$(( $(date +%s) - started ))
  echo "$(date -Is) agent 退出 code=${code}（存活 ${lived}s）" >>"$LOG"
  if [ "$lived" -lt 3 ]; then
    # 起不来就走远一点再试：别刷屏，也别把 CPU 打满
    echo "$(date -Is) 秒退：多半是 node 不在 PATH 或密钥没注入，30 秒后重试" >>"$LOG"
    sleep 30
  else
    sleep 5
  fi
done
