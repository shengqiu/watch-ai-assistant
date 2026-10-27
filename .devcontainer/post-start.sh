#!/usr/bin/env bash
# codespace 启动后自动拉起 shell agent。
#
# 幂等：pidfile + 「这个 pid 真的是 agent 吗」双重判断，重启/重连不会叠出多个 agent
# （多个 agent 会抢同一条 SSE，导致同一条命令被执行两次）。
# 自愈：agent 本体由 supervise.sh 守护，异常退出自动重起。
# 日志：~/.cache/watch-ai-shell/{agent.log, post-start.log}
#
# 密钥优先级：
#   1. 环境变量 WATCH_AI_AGENT_KEY（GitHub Codespaces secret 注入）
#   2. ~/.config/watch-ai/agent-key（存在持久卷里，重启不丢）
# 两者都没有就不启动——宁可没有 shell，也不要裸奔一个无鉴权的执行通道。
#
# v2026-10-27 两个修复：
#   a) pidfile 原来只做 `kill -0`。容器重启后 PID 会被复用（上次是 462 这种小号），
#      于是 postStart 以为 agent 还在跑 → 直接跳过 → 重启后根本没有 shell 通道。
#      现在还要确认 `ps -o args=` 里确实是 shell-agent/agent.mjs。
#   b) Codespaces secret 实际是从 /workspaces/.codespaces/shared/.env-secrets 经
#      /etc/profile.d/codespaces.sh 导出的，而那个脚本**只在 $SSH_CONNECTION 非空时**
#      才导出。postStart 不是 SSH 会话 → agent 及其 bash 里没有 GEMINI_API_KEY，
#      Gemini CLI 会以为没配 key。这里主动补一次。

set -u

REPO_DIR="${CODESPACE_VSCODE_FOLDER:-/workspaces/watch-ai-assistant}"
LOG_DIR="$HOME/.cache/watch-ai-shell"
PIDFILE="$LOG_DIR/agent.pid"
SECRETS_FILE="/workspaces/.codespaces/shared/.env-secrets"
mkdir -p "$LOG_DIR"

log() { echo "$(date -Is) $*" >>"$LOG_DIR/post-start.log"; }

cd "$REPO_DIR" 2>/dev/null || { log "仓库目录不存在：$REPO_DIR"; exit 0; }

# ---------------------------------------------------------------- 1) 补齐 secret
# 值与 /etc/profile.d/codespaces.sh 同源（base64），只是不依赖 SSH 会话。
# 只补我们确实要用的键；不遍历整份文件，避免 eval 引入注入面。
load_secret() {
  local name="$1" enc val
  eval "val=\${$name:-}"
  [ -n "$val" ] && return 0                  # 环境里已有，不覆盖
  [ -r "$SECRETS_FILE" ] || return 0
  enc=$(sed -n "s/^${name}=//p" "$SECRETS_FILE" | head -1)
  [ -n "$enc" ] || return 0
  val=$(printf '%s' "$enc" | base64 -d 2>/dev/null) || return 0
  [ -n "$val" ] || return 0
  export "$name=$val"
  log "已注入 secret $name（长度 ${#val}）"
}
load_secret WATCH_AI_AGENT_KEY
load_secret GEMINI_API_KEY

# ------------------------------------------------- 1.1) 写本机身份（X-Agent-Id）
# 用途：Worker 侧配了 AGENT_ID 时，只接受「这台开发机」的 agent 连接。
# 密钥万一泄漏，别的机器即使拿着它连上来，身份也对不上（多一层，非密码学绑定）。
# 取值优先级：CODESPACE_NAME → devContainerTelemetry.json 里的 environmentId。
# 两者都没有就留空（Worker 侧只记录不强制，不会因此断连）。
IDENTITY_FILE="$HOME/.config/watch-ai/agent-id"
if [ -z "${WATCH_AI_AGENT_ID:-}" ]; then
  id_val="${CODESPACE_NAME:-}"
  if [ -z "$id_val" ]; then
    id_val=$(sed -n 's/.*"environmentId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      /workspaces/.codespaces/shared/devContainerTelemetry.json 2>/dev/null | head -1)
  fi
  if [ -n "$id_val" ]; then
    mkdir -p "$(dirname "$IDENTITY_FILE")"
    printf '%s' "$id_val" >"$IDENTITY_FILE"
    log "已写入身份 $id_val"
  fi
fi

# ------------------------------------------------- 1.5) 一次性装 ripgrep（后台）
# Gemini CLI 找不到 rg 时会退化成 GrepTool，并在每条回答前打一行
# 「Ripgrep is not available. Falling back to GrepTool.」——Telegram 里纯噪音。
# 标记放 /tmp（容器级）：容器重建才重装一次，stop/start 不会重复 apt。
if ! command -v rg >/dev/null 2>&1 && [ ! -f /tmp/.watch-ai-rg-tried ]; then
  : >/tmp/.watch-ai-rg-tried
  (
    sudo apt-get update -qq >/dev/null 2>&1
    sudo apt-get install -y -qq ripgrep >/dev/null 2>&1
    command -v rg >/dev/null 2>&1 && echo "$(date -Is) ripgrep 已安装" >>"$LOG_DIR/post-start.log"
  ) &
fi

# 每次开机尽量快进到 origin/main，保证跑的是最新 agent。
# --ff-only：一旦分叉或本地有改动就静默跳过，绝不覆盖你在 codespace 里的工作。
git pull -q --ff-only origin main >/dev/null 2>&1 || true

# ------------------------------------------------- 1.9) 入站端口审计（只记日志）
# 通道方向是 agent 主动出站（SSE），开发机本来**不需要任何入站端口**。
# 这里只做审计：除 GitHub 自己的 2222(sshd)/2000(tunnel) 外还有监听就记一条，
# 方便事后追「谁把端口暴露了」——端口一旦被设成 public，任何人拿到 URL 就能进。
extra_listen=$(ss -ltn 2>/dev/null | awk '$4 ~ /^0\.0\.0\.0:/ || $4 ~ /^\[::\]:/ {print $4}' |
  grep -vE ':(2222|2000)$' | tr '\n' ' ')
[ -n "${extra_listen:-}" ] && log "⚠️ 检测到额外入站监听（确认是否必要，且必须是 private）：$extra_listen"

# ------------------------------------------------------- 2) 幂等：确认活着的真是 agent
agent_alive() {
  local p="${1:-}" args
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  args=$(ps -p "$p" -o args= 2>/dev/null) || return 1
  case "$args" in
    *shell-agent/agent.mjs*) return 0 ;;
    *) return 1 ;;   # PID 被复用：pidfile 是上个容器的残留
  esac
}

if [ -f "$PIDFILE" ]; then
  if agent_alive "$(cat "$PIDFILE" 2>/dev/null)"; then
    log "agent 已在运行（pid=$(cat "$PIDFILE")），跳过"
    exit 0
  fi
  log "pidfile 残留（pid=$(cat "$PIDFILE" 2>/dev/null) 不是 agent），重新拉起"
  rm -f "$PIDFILE"
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
