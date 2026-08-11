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

# ------------------------------------------------------------------ the lock
#
# Four Next apps share one 1 vCPU box, and each repo's GitHub `concurrency`
# group only serialises against ITSELF — GitHub cannot serialise across
# repositories. Two apps building at once on ~600 MB free is an OOM, not a slow
# deploy. The lock is shared BY PATH, so this must be the exact file the other
# apps use; a differently-named lock never contends, which is how two builds
# collided in the first place. See ~/Git/INFRA.md (owned by the droplet agent).
LOCK="${DEPLOY_LOCK:-/var/lock/droplet-deploy.lock}"
if command -v flock >/dev/null 2>&1; then
  # 0666 on purpose: root deploys by hand, CI deploys as `deploy`, and a
  # root-owned lock is one CI cannot open.
  if [ ! -e "$LOCK" ]; then
    ( umask 000; : > "$LOCK" ) 2>/dev/null || true
  fi
  # "Cannot open" and "waited and timed out" are different failures and must
  # read differently — conflating them once produced a log claiming a
  # half-hour wait that never happened.
  if exec 9>"$LOCK"; then
    if flock -w 1800 9; then
      echo "==> holding $LOCK"
    else
      echo "!!  another deploy held $LOCK for 30 minutes; giving up." >&2
      exit 1
    fi
  else
    echo "!!  cannot open $LOCK (permissions?) — continuing WITHOUT the lock." >&2
    echo "!!  fix: sudo chmod 666 $LOCK" >&2
  fi
else
  echo "!!  flock unavailable — deploys are NOT serialised on this host." >&2
fi

# Whatever Node this host actually has. There is no nvm on the droplet and the
# system Node is 22; this script used to ask nvm for 20, which did nothing
# there — but DID pin 20 on a dev machine that has nvm, so the build quietly
# differed from the runtime it ships to.
echo "==> node $(node -v) / npm $(npm -v)"

# systemd unit name. Override with CARPARK_SERVICE=... if yours differs.
SERVICE="${CARPARK_SERVICE:-carpark}"

# Server-only branding patch (a private skin for a subdomain). It is kept OUT
# of git on purpose, lives next to the repo on the server, and MUST be
# re-applied here because the deploy hard-resets the working tree — otherwise
# every deploy silently reverts that subdomain to default branding.
PATCH="${CARPARK_LOCAL_PATCH:-../carpark-anne.patch}"
if [ -f "$PATCH" ]; then
  if git apply --check "$PATCH" 2>/dev/null; then
    git apply "$PATCH"
    echo "==> applied server-only branding patch ($PATCH)"
  else
    # Don't fail the deploy — the app still serves, just unbranded — but make
    # this impossible to miss in the Actions log.
    echo "!!  WARNING: $PATCH no longer applies to this commit." >&2
    echo "!!  That subdomain will show DEFAULT branding until the patch is refreshed." >&2
  fi
fi

# npm ci wipes node_modules and recompiles better-sqlite3 from source, which is
# minutes of work on a 1 vCPU box shared with other apps — and pointless when
# the dependencies haven't moved. Only reinstall when the lockfile actually
# changes. node_modules is gitignored, so the stamp survives the hard reset.
STAMP="node_modules/.deps-lock-hash"
LOCK_HASH="$(sha1sum package-lock.json | cut -d' ' -f1)"
if [ -d node_modules ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$LOCK_HASH" ]; then
  echo "==> dependencies unchanged, skipping npm ci"
else
  echo "==> npm ci (recompiles better-sqlite3 for this host)"
  npm ci
  echo "$LOCK_HASH" >"$STAMP"
fi

# better-sqlite3 is a native addon; built against the wrong Node ABI it fails
# at RUNTIME, so without this a broken deploy reports success and the site 500s
# on its first database request.
#
# It must construct a Database. `require('better-sqlite3')` alone does NOT load
# the binary — bindings() runs inside the constructor — so a require-only check
# passes on a genuine mismatch and is worse than no check, because it looks
# like one. Runs on every deploy, not just after npm ci: the install above is
# skipped when the lockfile is unchanged, and a host's Node can move underneath
# an unchanged node_modules.
echo "==> checking the better-sqlite3 binary loads"
node -e "new (require('better-sqlite3'))(':memory:').close()" || {
  echo "!!  better-sqlite3 will not load on node $(node -v) — ABI mismatch." >&2
  echo "!!  fix: rm -rf node_modules node_modules/.deps-lock-hash && npm ci" >&2
  exit 1
}

echo "==> next build"
npm run build

echo "==> restarting ${SERVICE}"
sudo systemctl restart "${SERVICE}"

echo "==> deployed $(git rev-parse --short HEAD) on $(hostname)"
