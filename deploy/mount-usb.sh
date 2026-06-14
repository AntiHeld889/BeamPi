#!/usr/bin/env bash
#
# Sucht einen vorbereiteten BeamPi-USB-Stick (Ordner "Videos" im Wurzel-
# verzeichnis) und hängt ihn schreibgeschützt nach /media/beampi-usb ein.
# Wird als root vom Dienst beampi-usb.service VOR beampi.service ausgeführt.
#
# Bewusst tolerant: Findet sich kein passender Stick, endet das Skript ohne
# Fehler – BeamPi startet dann im Normalbetrieb.

set -u
TARGET=/media/beampi-usb
mkdir -p "$TARGET"

# Schon eingehängt (z. B. nach einem Neustart des Dienstes)? Dann nichts tun.
if mountpoint -q "$TARGET"; then
  echo "BeamPi-USB bereits eingehängt."
  exit 0
fi

shopt -s nullglob
# Nur echte USB-Partitionen betrachten (per-id-Symlinks gibt es nur für USB).
for link in /dev/disk/by-id/usb-*-part*; do
  dev="$(readlink -f "$link")"
  [ -b "$dev" ] || continue

  probe="$(mktemp -d)"
  if mount -o ro "$dev" "$probe" 2>/dev/null; then
    if [ -d "$probe/Videos" ]; then
      umount "$probe" 2>/dev/null
      rmdir "$probe" 2>/dev/null
      if mount -o ro "$dev" "$TARGET" 2>/dev/null; then
        echo "BeamPi-USB eingehängt: $dev -> $TARGET"
        exit 0
      fi
      echo "Konnte $dev nicht nach $TARGET einhängen." >&2
      exit 0
    fi
    umount "$probe" 2>/dev/null
  fi
  rmdir "$probe" 2>/dev/null
done

echo "Kein BeamPi-USB-Stick gefunden – Normalbetrieb."
exit 0
