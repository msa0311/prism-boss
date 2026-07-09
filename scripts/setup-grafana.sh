#!/usr/bin/env bash
# setup-grafana.sh — install a self-contained Grafana + the SQLite datasource
# into the boss's persistent data dir, wired to read /data/boss/assessments.db
# and serve under /apps/grafana (via prism's exposed-apps proxy).
#
# Idempotent: safe to re-run. The boss runs this once during setup; the
# artifacts live on the /data volume and survive restarts.
#
# Env:
#   BOSS_DATA_DIR   base dir (default: /data if present, else ~/.prism)
#   GRAFANA_VERSION Grafana OSS version (default below)
#   APP_PATH        public sub-path the proxy serves it under (default /apps/grafana)
set -euo pipefail

GRAFANA_VERSION="${GRAFANA_VERSION:-11.6.0}"
APP_PATH="${APP_PATH:-/apps/grafana}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${BOSS_DATA_DIR:-}" ]; then DATA="$BOSS_DATA_DIR"; elif [ -d /data ]; then DATA=/data; else DATA="$HOME/.prism"; fi
GRAFANA_HOME="$DATA/grafana"
BOSS_DIR="$DATA/boss"
DASHBOARDS_DIR="$DATA/grafana-dashboards"
PROV="$GRAFANA_HOME/conf/provisioning"

log() { echo "[setup-grafana] $*"; }

os() { case "$(uname -s)" in Darwin) echo darwin;; *) echo linux;; esac; }
arch() { case "$(uname -m)" in arm64|aarch64) echo arm64;; *) echo amd64;; esac; }

mkdir -p "$DATA" "$BOSS_DIR" "$DASHBOARDS_DIR"

# --- 1. Grafana binaries ---------------------------------------------------
if [ ! -x "$GRAFANA_HOME/bin/grafana" ] && [ ! -x "$GRAFANA_HOME/bin/grafana-server" ]; then
  OS="$(os)"; ARCH="$(arch)"
  TARBALL="grafana-${GRAFANA_VERSION}.${OS}-${ARCH}.tar.gz"
  URL="https://dl.grafana.com/oss/release/${TARBALL}"
  log "downloading Grafana ${GRAFANA_VERSION} (${OS}-${ARCH})"
  TMP="$(mktemp -d)"
  curl -fsSL "$URL" -o "$TMP/g.tar.gz"
  mkdir -p "$GRAFANA_HOME"
  tar -xzf "$TMP/g.tar.gz" -C "$TMP"
  # tarball extracts to grafana-vX.Y.Z/ or grafana-vX.Y.Z.<os>-<arch>/
  SRC="$(find "$TMP" -maxdepth 1 -type d -name 'grafana-*' | head -1)"
  cp -R "$SRC"/. "$GRAFANA_HOME"/
  rm -rf "$TMP"
  log "Grafana installed at $GRAFANA_HOME"
else
  log "Grafana already present at $GRAFANA_HOME"
fi

GRAFANA_BIN="$GRAFANA_HOME/bin/grafana"
[ -x "$GRAFANA_BIN" ] || GRAFANA_BIN="$GRAFANA_HOME/bin/grafana-server"

# --- 2. SQLite datasource plugin ------------------------------------------
if [ ! -d "$GRAFANA_HOME/data/plugins/frser-sqlite-datasource" ]; then
  log "installing frser-sqlite-datasource plugin"
  # `grafana cli` (v10+) or legacy `grafana-cli`; both need the homepath.
  if [ -x "$GRAFANA_HOME/bin/grafana" ]; then
    "$GRAFANA_HOME/bin/grafana" cli --homepath "$GRAFANA_HOME" --pluginsDir "$GRAFANA_HOME/data/plugins" plugins install frser-sqlite-datasource
  else
    "$GRAFANA_HOME/bin/grafana-cli" --homepath "$GRAFANA_HOME" --pluginsDir "$GRAFANA_HOME/data/plugins" plugins install frser-sqlite-datasource
  fi
else
  log "SQLite datasource plugin already installed"
fi

# --- 3. Provisioning: datasource + dashboards ------------------------------
mkdir -p "$PROV/datasources" "$PROV/dashboards"

cat > "$PROV/datasources/sqlite.yaml" <<EOF
apiVersion: 1
datasources:
  - name: Assessments
    type: frser-sqlite-datasource
    uid: boss-sqlite
    isDefault: true
    jsonData:
      path: $BOSS_DIR/assessments.db
EOF

cat > "$PROV/dashboards/boss.yaml" <<EOF
apiVersion: 1
providers:
  - name: boss
    type: file
    allowUiUpdates: false
    options:
      path: $DASHBOARDS_DIR
      foldersFromFilesStructure: false
EOF

cp "$SKILL_DIR/assets/team-work.json" "$DASHBOARDS_DIR/team-work.json"
log "provisioning written; dashboard copied to $DASHBOARDS_DIR"

# --- 4. Grafana config: serve under the app sub-path, anonymous viewer -----
cat > "$GRAFANA_HOME/conf/custom.ini" <<EOF
[server]
http_addr = 127.0.0.1
http_port = 3000
root_url = %(protocol)s://%(domain)s${APP_PATH}/
serve_from_sub_path = true

[security]
allow_embedding = true

[auth.anonymous]
enabled = true
org_role = Viewer

[analytics]
reporting_enabled = false
check_for_updates = false
EOF

# Ensure an empty sqlite db exists so provisioning connects on first boot.
if [ ! -f "$BOSS_DIR/assessments.db" ]; then
  node "$SKILL_DIR/scripts/record-assessment.mjs" --rebuild >/dev/null 2>&1 || true
fi

log "done. start with: scripts/ensure-grafana.sh   (Grafana → ${APP_PATH})"
