#!/usr/bin/env bash
# ensure-grafana.sh — start Grafana if it isn't already running.
# Called at the start of every boss run (the honest self-heal: the sandbox has
# no init system, so a restart leaves Grafana down until the next run).
set -euo pipefail

if [ -n "${BOSS_DATA_DIR:-}" ]; then DATA="$BOSS_DATA_DIR"; elif [ -d /data ]; then DATA=/data; else DATA="$HOME/.prism"; fi
GRAFANA_HOME="$DATA/grafana"

if [ ! -d "$GRAFANA_HOME/bin" ]; then
  echo "[ensure-grafana] not installed — run scripts/setup-grafana.sh first" >&2
  exit 1
fi

if pgrep -f "grafana.*server" >/dev/null 2>&1; then
  echo "[ensure-grafana] already running"
  exit 0
fi

cd "$GRAFANA_HOME"
LOG="$DATA/boss/grafana.log"
mkdir -p "$DATA/boss"

# v10+ uses `grafana server`; older uses `grafana-server`.
if [ -x "$GRAFANA_HOME/bin/grafana" ]; then
  nohup "$GRAFANA_HOME/bin/grafana" server \
    --homepath "$GRAFANA_HOME" \
    --config "$GRAFANA_HOME/conf/custom.ini" >>"$LOG" 2>&1 &
else
  nohup "$GRAFANA_HOME/bin/grafana-server" \
    --homepath "$GRAFANA_HOME" \
    --config "$GRAFANA_HOME/conf/custom.ini" >>"$LOG" 2>&1 &
fi

echo "[ensure-grafana] started (pid $!), logging to $LOG"
