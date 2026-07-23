#!/usr/bin/env bash
# 半自动部署: 本地跑 ./deploy.sh (或 pnpm deploy)
# = ssh 到服务器 git pull + 重启 systemd + 健康检查
set -euo pipefail

SSH_KEY="${SPLAT_SSH_KEY:-$HOME/SHDebian.pem}"
HOST="root@1.15.12.238"
APP_DIR="/opt/splat-ludo"
SERVICE="splat-ludo"
PORT=3010

# 本地未推送的 commit 是部署不上去的, 先挡下来
git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "✋ 本地 HEAD ($(git rev-parse --short HEAD)) 和 origin/main ($(git rev-parse --short origin/main)) 不一致"
  echo "   先 git push (或 git pull) 再部署。"
  exit 1
fi

echo "🚀 部署 $(git rev-parse --short HEAD) → $HOST ..."
ssh -i "$SSH_KEY" "$HOST" bash -s "$APP_DIR" "$SERVICE" "$PORT" "$LOCAL" <<'REMOTE_SCRIPT'
set -euo pipefail
APP_DIR=$1; SERVICE=$2; PORT=$3; EXPECT=$4
cd "$APP_DIR"
git pull --ff-only
DEPLOYED=$(git rev-parse HEAD)
if [ "$DEPLOYED" != "$EXPECT" ]; then
  echo "✋ 服务器上是 $DEPLOYED, 和本地 $EXPECT 不一致, 中止 (未重启, 旧进程还在跑)"
  exit 1
fi
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || { echo "❌ 服务未启动:"; journalctl -u "$SERVICE" -n 20 --no-pager; exit 1; }
for path in / /games/ludo/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$path")
  case "$code" in
    200|302) echo "  ✓ $path → $code" ;;
    *) echo "❌ $path → $code"; journalctl -u "$SERVICE" -n 20 --no-pager; exit 1 ;;
  esac
done
echo "✅ 部署完成: $(git log --oneline -1)"
REMOTE_SCRIPT
