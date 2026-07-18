#!/usr/bin/env bash
# Deploy telegram-tc to the home server, preserving the live DB + Telegram session.
#
# The server runs one Docker container (telegram-tc-app-1) built from the code folder
# ($REMOTE_DIR) but mounting the LIVE data dir (/home/kamo/telegram-tc/data) for the
# database and Telegram session. This script backs up the live DB, syncs the current
# working tree, rebuilds the image while the old container keeps serving, swaps the
# container, then verifies health and that the live data survived.
#
# Usage:  bash scripts/deploy.sh   (or: bun run deploy)
# Overridable via env: DEPLOY_SERVER, DEPLOY_REMOTE_DIR, DEPLOY_CONTAINER, DEPLOY_BASE_URL
set -euo pipefail

SERVER="${DEPLOY_SERVER:-kamo@192.168.0.100}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/home/kamo/code/telegram-tc}"
CONTAINER="${DEPLOY_CONTAINER:-telegram-tc-app-1}"
BASE_URL="${DEPLOY_BASE_URL:-http://127.0.0.1:18787}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

sshx() { ssh -o BatchMode=yes "$SERVER" "$@"; }

REV="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
BR="$(git -C "$REPO_ROOT" branch --show-current)"
echo "==> Deploying ${BR}@${REV} to ${SERVER}:${REMOTE_DIR}"

echo "==> [1/5] Backing up live DB"
if sshx "curl -fsS -X POST ${BASE_URL}/api/admin/backup"; then
  echo
else
  echo "   /api/admin/backup unavailable; falling back to a file copy"
  sshx "mkdir -p ~/db-backups && docker cp ${CONTAINER}:/app/data/telegram-tc.db ~/db-backups/predeploy-\$(date +%Y%m%d-%H%M%S).db && echo '   backed up'"
fi

echo "==> [2/5] Syncing code (data/env/backups are excluded)"
rsync -az --delete \
  --exclude='.git' --exclude='node_modules' --exclude='**/node_modules' \
  --exclude='dist' --exclude='apps/web/dist' --exclude='data' \
  --exclude='.env' --exclude='.env.*' --exclude='*.bak-*' --exclude='deploy-backups' \
  --exclude='.claude' --exclude='output' \
  "${REPO_ROOT}/" "${SERVER}:${REMOTE_DIR}/" || { rc=$?; if [ "$rc" -ne 23 ] && [ "$rc" -ne 24 ]; then echo "rsync failed ($rc)"; exit "$rc"; fi; }

echo "==> [3/5] Building image (old container keeps serving)"
sshx "cd ${REMOTE_DIR} && docker compose build"

echo "==> [4/5] Swapping container"
sshx "docker rm -f ${CONTAINER} >/dev/null 2>&1 || true; cd ${REMOTE_DIR} && docker compose up -d"

echo "==> [5/5] Verifying"
sshx "
  for i in \$(seq 1 30); do h=\$(curl -sS -m 4 ${BASE_URL}/api/health 2>/dev/null); [ -n \"\$h\" ] && { echo \"   health: \$h\"; break; }; sleep 2; done
  echo -n '   served build: '; curl -sS -m 5 ${BASE_URL}/ 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1
  echo -n '   live accounts: '; curl -sS -m 5 ${BASE_URL}/api/mt5/accounts 2>/dev/null | grep -oE '\"id\"' | wc -l | tr -d ' '
  echo -n '   telegram: '; curl -sS -m 6 ${BASE_URL}/api/telegram/status 2>/dev/null | grep -oE '\"connected\":(true|false)' | head -1
  docker ps --filter name=${CONTAINER} --format '   container: {{.Status}}'
"
echo "==> Done. ${BR}@${REV} is live at ${BASE_URL}."
