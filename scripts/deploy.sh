#!/usr/bin/env bash
#
# Build the currently checked-out commit and restart the service.
#
# The GitHub Actions "Deploy to droplet" workflow updates git first, then runs
# this over SSH. To deploy by hand on the droplet:
#
#     cd ~/carpark-sg && git pull --ff-only && bash scripts/deploy.sh
#
# The SQLite database lives in ./data (gitignored), so nothing here touches it.
set -euo pipefail

# Repo root, regardless of where it's cloned or called from.
cd "$(dirname "$0")/.."

# Prefer nvm's Node 20 if this host uses nvm; otherwise fall back to the system
# Node on PATH (the droplet's deploy user has system Node 20, no nvm).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use 20 >/dev/null
fi

# systemd unit name. Override with CARPARK_SERVICE=... if yours differs.
SERVICE="${CARPARK_SERVICE:-carpark}"

echo "==> npm ci (recompiles better-sqlite3 for this host)"
npm ci

echo "==> next build"
npm run build

echo "==> restarting ${SERVICE}"
sudo systemctl restart "${SERVICE}"

echo "==> deployed $(git rev-parse --short HEAD) on $(hostname)"
