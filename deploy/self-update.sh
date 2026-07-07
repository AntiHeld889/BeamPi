#!/usr/bin/env bash
#
# BeamPi Selbst-Update: holt den aktuellen main-Stand von GitHub, ersetzt den
# Code (ohne data/videos/node_modules/Secrets) und startet den Dienst neu.
#
# Aufruf (vom Server abgekoppelt gestartet, siehe src/updater.js):
#   self-update.sh <installDir> <nodePid> <tarballUrl>
#
# Läuft als eigenständiger Prozess weiter, auch wenn der Node-Dienst beendet
# wird. Bricht set -e bei einem Fehler ab, BEVOR neu gestartet wird – dann läuft
# die alte (funktionierende) Version unverändert weiter.

set -euo pipefail

DIR="${1:?installDir fehlt}"
PID="${2:?Node-PID fehlt}"
URL="${3:?Tarball-URL fehlt}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "BeamPi-Update: lade $URL"

# 1) Aktuellen Stand herunterladen und entpacken
curl -fsSL "$URL" -o "$TMP/src.tar.gz"
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
# GitHub packt alles in einen Unterordner "BeamPi-<branch>"
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d -name 'BeamPi-*' | head -n1)"
[ -n "$SRC" ] || { echo "Entpacktes Verzeichnis nicht gefunden – Abbruch."; exit 1; }

# Plausibilitätscheck: nur übernehmen, wenn der Download wirklich BeamPi ist
[ -f "$SRC/server.js" ] && [ -f "$SRC/package.json" ] \
  || { echo "Download unvollständig (server.js/package.json fehlt) – Abbruch."; exit 1; }

# 2) Abhängigkeiten im neuen Stand vorbereiten. Schlägt das fehl, bleibt die
#    aktuelle Installation unangetastet.
cd "$SRC"
npm install --omit=dev --no-audit --no-fund

# 3) Code übernehmen – Nutzdaten und Secrets bleiben unangetastet.
#    Gleiche Excludes wie beim regulären rsync-Deploy (deploy.sh).
rsync -a --delete --delay-updates \
  --exclude data \
  --exclude videos \
  --exclude .deploy-pass \
  --exclude .DS_Store \
  "$SRC/" "$DIR/"

# 4) Neu starten: den laufenden Node-Prozess beenden – systemd (Restart=always)
#    bringt BeamPi nach RestartSec mit dem neuen Code wieder hoch.
echo "BeamPi-Update fertig – starte Dienst neu (PID $PID)."
sleep 1
kill "$PID" 2>/dev/null || true
