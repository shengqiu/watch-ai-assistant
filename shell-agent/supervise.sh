#!/usr/bin/env bash
# shell-agent 守护进程：agent 退出（崩溃 / SSE 被踢 / OOM）后 5 秒重起。
#
# 为什么需要它：codespace 内的 agent 是唯一能让 devbot 反向执行命令的通道，
# 它一旦静默死掉，Telegram 那边只会显示「shell 未连接」，很难排查。
# 用 supervisor 包一层，异常退出能自愈；codespace 本身被 stop 时整个容器
# 一起消失，不会留下孤儿进程。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${HOME}/.cache/watch-ai-shell"
LOG="${LOG_DIR}/agent.log"
mkdir -p "$LOG_DIR"

while true; do
  node "$HERE/agent.mjs" >>"$LOG" 2>&1
  code=$?
  echo "$(date -Is) agent 退出 code=${code}，5 秒后重启" >>"$LOG"
  sleep 5
done
