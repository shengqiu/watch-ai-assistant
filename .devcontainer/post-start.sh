#!/usr/bin/env bash
# codespace 启动后自动拉起 shell agent。
#
# 幂等：pidfile + kill -0 双重判断，重启/重连不会叠出多个 agent
# （多个 agent 会抢同一条 SSE，导致同一条命令被执行两次）。
# 自愈：agent 本体由 supervise.sh 守护，异常退出自动重起。
# 日志：~/.cache/watch-ai-shell/{agent.log, post-start.log}
#
# 密钥优先级：
#   1. 环境变量 WATCH_AI_AGENT_KEY（GitHub Codespaces secret 注入）
#   2. ~/.config/watch-ai/agent-key（存在持久卷里，重启不丢）
# 两者都没有就不启动——宁可没有 shell，也不要裸奔一个无鉴权的执行通道。

set -u

REPO_DIR="${CODESPACE_VSCODE_FOLDER:-/workspaces/watch-ai-assistant}"
LOG_DIR="$HOME/.cache/watch-ai-shell"
PIDFILE="$LOG_DIR/agent.pid"
mkdir -p "$LOG_DIR"

log() { echo "$(date -Is) $*" >>"$LOG_DIR/post-start.log"; }

cd "$REPO_DIR" 2>/dev/null || { log "仓库目录不存在：$REPO_DIR"; exit 0; }

# 每次开机尽量快进到 origin/main，保证跑的是最新 agent。
# --ff-only：一旦分叉或本地有改动就静默跳过，绝不覆盖你在 codespace 里的工作。
git pull -q --ff-only origin main >/dev/null 2>&1 || true

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  log "agent 已在运行（pid=$(cat "$PIDFILE")），跳过"
  exit 0
fi
# pidfile 丢了的兜底：按进程名再查一次（用 [] 避免 pgrep 匹配到本脚本）
if pgrep -f "shell-agen[t]/agent.mjs" >/dev/null 2>&1; then
  log "检测到残留 agent 进程，跳过启动"
  exit 0
fi

if [ -z "${WATCH_AI_AGENT_KEY:-}" ] && [ ! -f "$HOME/.config/watch-ai/agent-key" ]; then
  log "两处都没有 agent key，未启动"
  exit 0
fi

setsid nohup bash shell-agent/supervise.sh >>"$LOG_DIR/supervise.log" 2>&1 < /dev/null &
echo $! >"$PIDFILE"
log "已拉起 supervisor pid=$!"
