#!/usr/bin/env bash
# codespace 启动后自动拉起 shell agent。
#
# 幂等：用 pgrep 判断是否已在运行，避免重启/重连时叠出多个 bash 会话。
# 日志：~/.cache/watch-ai-shell/（agent.log = agent 输出，post-start.log = 本脚本）
#
# 密钥 WATCH_AI_AGENT_KEY 走 GitHub Codespaces secret（仓库 Settings →
# Secrets and variables → Codespaces），会以环境变量形式注入容器，不进仓库。

set -u

REPO_DIR="${CODESPACE_VSCODE_FOLDER:-/workspaces/watch-ai-assistant}"
LOG_DIR="$HOME/.cache/watch-ai-shell"
mkdir -p "$LOG_DIR"

cd "$REPO_DIR" || exit 0

if pgrep -f "shell-agent/agent.mjs" >/dev/null 2>&1; then
  echo "$(date -Is) agent 已在运行，跳过" >>"$LOG_DIR/post-start.log"
  exit 0
fi

if [ -z "${WATCH_AI_AGENT_KEY:-}" ]; then
  echo "$(date -Is) 缺少 WATCH_AI_AGENT_KEY，未启动 agent" >>"$LOG_DIR/post-start.log"
  exit 0
fi

nohup node shell-agent/agent.mjs >>"$LOG_DIR/agent.log" 2>&1 &
echo "$(date -Is) agent 已拉起 pid=$!" >>"$LOG_DIR/post-start.log"
