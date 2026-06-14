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
# Jede Kandidaten-Partition direkt nach $TARGET einhängen und auf "Videos/"
# prüfen – passt sie nicht, wieder aushängen und nächste probieren. Kein
# Probe-Mount/mktemp, daher auch kein hängendes Temp-Verzeichnis.
for link in /dev/disk/by-id/usb-*-part*; do
  dev="$(readlink -f "$link")"
  [ -b "$dev" ] || continue

  # Bereits eingehängte Geräte NICHT anfassen: das schließt eine USB-System-
  # SSD (Root-Dateisystem) ebenso aus wie einen vom Desktop automatisch
  # gemounteten Stick (den findet BeamPi dann unter /media/pi/<Name>).
  if findmnt -n -S "$dev" >/dev/null 2>&1; then
    continue
  fi

  mount -o ro "$dev" "$TARGET" 2>/dev/null || continue
  if [ -d "$TARGET/Videos" ]; then
    echo "BeamPi-USB eingehängt: $dev -> $TARGET"
    exit 0
  fi
  # Passt nicht – sauber wieder aushängen und weitersuchen.
  umount "$TARGET" 2>/dev/null || umount -l "$TARGET" 2>/dev/null
done

echo "Kein BeamPi-USB-Stick gefunden – Normalbetrieb."
exit 0
