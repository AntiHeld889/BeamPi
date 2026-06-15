#!/usr/bin/env bash
#
# BeamPi-Deploy: pusht zu GitHub und synchronisiert auf den Raspberry Pi.
#
#   ./deploy.sh            – Push + Sync + (falls nötig) Dienst-Neustart
#   ./deploy.sh --no-push  – nur auf den Pi deployen, ohne GitHub-Push
#
# Zugangsdaten: Das SSH-Passwort kommt aus der Datei .deploy-pass neben
# diesem Skript (steht in .gitignore) oder aus $BEAMPI_SSH_PASS.
# Alternativ funktioniert auch ein eingerichteter SSH-Key ganz ohne Passwort.

set -euo pipefail
cd "$(dirname "$0")"

PI_HOST="${BEAMPI_HOST:-pi@192.168.1.54}"
PI_PATH="${BEAMPI_PATH:-/opt/beampi}"
PI_PORT="${BEAMPI_PORT:-8080}"

# --- Passwort/SSH-Wrapper ----------------------------------------------------
PASS="${BEAMPI_SSH_PASS:-}"
if [[ -z "$PASS" && -f .deploy-pass ]]; then
  PASS="$(<.deploy-pass)"
fi

if [[ -n "$PASS" ]]; then
  command -v sshpass >/dev/null || { echo "✗ sshpass fehlt (brew install sshpass)"; exit 1; }
  # -e statt -p: Passwort landet nicht in der Prozessliste
  export SSHPASS="$PASS"
  SSH=(sshpass -e ssh)
  RSYNC_RSH="sshpass -e ssh"
else
  SSH=(ssh)
  RSYNC_RSH="ssh"
fi

# --- 1) Git-Push ---------------------------------------------------------------
if [[ "${1:-}" != "--no-push" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "✗ Es gibt uncommittete Änderungen – bitte zuerst committen."
    git status --short
    exit 1
  fi
  echo "→ Pushe zu GitHub …"
  git push origin main
fi

# --- 2) Sync auf den Pi -----------------------------------------------------------
echo "→ Synchronisiere nach $PI_HOST:$PI_PATH …"
# rsync-Fehler dürfen nicht im grep untergehen – erst Ausgabe einsammeln
RSYNC_OUT="$(rsync -azi --delete -e "$RSYNC_RSH" \
  --exclude node_modules --exclude data --exclude videos \
  --exclude .git --exclude .deploy-pass --exclude .DS_Store \
  ./ "$PI_HOST:$PI_PATH/")" || { echo "✗ rsync fehlgeschlagen"; exit 1; }
# '^<' = übertragene Dateien, '^\*deleting' = auf dem Pi entfernte Dateien
CHANGES="$(grep -E '^(<|\*deleting)' <<< "$RSYNC_OUT" || true)"

if [[ -z "$CHANGES" ]]; then
  echo "✓ Pi ist bereits aktuell – nichts zu tun."
  exit 0
fi
echo "$CHANGES" | awk '{print "   " $2}'

# --- 3) npm install, falls package.json geändert -------------------------------------
if grep -q 'package.json' <<< "$CHANGES"; then
  echo "→ package.json geändert – npm install auf dem Pi …"
  "${SSH[@]}" "$PI_HOST" "cd $PI_PATH && npm install --omit=dev"
fi

# --- 3b) systemd-Units + udev-Regel installieren, falls deploy/ geändert -------------
if awk '{print $2}' <<< "$CHANGES" | grep -qE '^deploy/.*\.(service|rules|sh)$'; then
  echo "→ Units/udev-Regel geändert – installiere und aktiviere auf dem Pi …"
  UNIT_CMD="cp $PI_PATH/deploy/beampi.service $PI_PATH/deploy/beampi-usb.service $PI_PATH/deploy/beampi-usb-umount.service /etc/systemd/system/ && cp $PI_PATH/deploy/99-beampi-usb.rules /etc/udev/rules.d/ && chmod +x $PI_PATH/deploy/mount-usb.sh $PI_PATH/deploy/umount-usb.sh && systemctl daemon-reload && systemctl enable beampi-usb.service >/dev/null 2>&1 && udevadm control --reload-rules >/dev/null 2>&1"
  if [[ -n "$PASS" ]]; then
    printf '%s\n' "$PASS" | "${SSH[@]}" "$PI_HOST" "sudo -S sh -c '$UNIT_CMD' 2>/dev/null"
  else
    "${SSH[@]}" "$PI_HOST" "sudo -n sh -c '$UNIT_CMD'" || {
      echo "✗ Unit-Installation braucht das sudo-Passwort – .deploy-pass anlegen oder BEAMPI_SSH_PASS setzen."
      exit 1
    }
  fi
fi

# --- 4) Neustart nur bei Server-Änderungen (public/, README etc. brauchen keinen) -----
if awk '{print $2}' <<< "$CHANGES" | grep -qE '^(server\.js|src/|package(-lock)?\.json|deploy/)'; then
  echo "→ Server-Code geändert – starte beampi-Dienst neu …"
  if [[ -n "$PASS" ]]; then
    # Passwort über stdin statt im Kommando (ps-sicher, robust gegen Sonderzeichen)
    printf '%s\n' "$PASS" | "${SSH[@]}" "$PI_HOST" "sudo -S systemctl restart beampi 2>/dev/null"
  else
    # Ohne Passwort klappt sudo nur mit NOPASSWD-Regel – sonst klare Meldung
    "${SSH[@]}" "$PI_HOST" "sudo -n systemctl restart beampi" || {
      echo "✗ Neustart braucht das sudo-Passwort – .deploy-pass anlegen oder BEAMPI_SSH_PASS setzen."
      exit 1
    }
  fi
  sleep 3
else
  echo "→ Nur statische Dateien – Dienst läuft ohne Unterbrechung weiter."
fi

# --- 5) Health-Check --------------------------------------------------------------------
HOST_ONLY="${PI_HOST#*@}"
# /api/session ist auch ohne Anmeldung erreichbar
if curl -fsS --max-time 5 "http://$HOST_ONLY:$PI_PORT/api/session" >/dev/null; then
  echo "✓ Deployment fertig – BeamPi antwortet auf http://$HOST_ONLY:$PI_PORT"
else
  echo "✗ BeamPi antwortet nicht – bitte Journal prüfen: ssh $PI_HOST 'sudo journalctl -u beampi -n 30'"
  exit 1
fi
