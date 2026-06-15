#!/usr/bin/env bash
#
# Hängt /media/beampi-usb aus, sobald der zugehörige USB-Stick entfernt wurde.
# Wird per udev (beampi-usb-umount.service) beim Abziehen eines USB-Geräts
# aufgerufen. Hängt nur aus, wenn die Quelle wirklich verschwunden ist – so
# führt das Entfernen eines ANDEREN USB-Geräts nicht zum versehentlichen
# Aushängen des Sticks.

set -u
TARGET=/media/beampi-usb

mountpoint -q "$TARGET" || exit 0

SRC="$(findmnt -fn -o SOURCE "$TARGET" 2>/dev/null || true)"
# Quelle noch als Blockgerät vorhanden? Dann wurde ein anderes Gerät entfernt.
if [ -n "$SRC" ] && [ -b "$SRC" ]; then
  exit 0
fi

umount -l "$TARGET" 2>/dev/null || true
echo "BeamPi-USB ausgehängt (Stick entfernt)."
exit 0
