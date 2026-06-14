# BeamPi

Beamer-Videoplayer für den Raspberry Pi — kompletter Neubau von
[BeamerPi](https://github.com/AntiHeld889/BeamerPi) mit Node.js 24 und moderner Web-UI.

Ein **Loop-Video** läuft in Dauerschleife im Vollbild (mpv). Per **Trigger**
(Web-UI, HTTP-API oder Webhook) wird das jeweils nächste Video der aktiven
Playlist einmal abgespielt, danach geht es zurück zum Loop.

## Funktionen

- Playlists mit Loop-Video und geordneter Trigger-Videoliste (erstellen, bearbeiten, duplizieren, löschen, starten)
- Playlist-Editor mit Video-Bibliothek (Ordnerbaum), Suche, Browser-Vorschau und Drag-&-Drop-Sortierung
- Live-Status (Standby / Loop / On Air) per Server-Sent-Events
- Live-Vorschau im Dashboard: zeigt positionssynchron, was der Beamer gerade ausgibt
- Einstellungen: mpv-Audio-Device, Videoverzeichnis, Auto-Start-Playlist
- Video-Upload und Ordnerverwaltung direkt im Browser
- Ausgehende Webhooks bei Trigger-Start und Trigger-Ende (POST JSON, GET-Fallback)
- GPIO-Taster als Trigger: Taster zwischen konfigurierbarem BCM-Pin und GND (interner Pull-up, Entprellung; benötigt das Paket `gpiod`)
- USB-Stick-Modus: vorbereiteten USB-Stick einstecken, Pi einschalten – läuft (ganz ohne Web-Oberfläche)
- HTTP-API kompatibel zum Original

## USB-Stick-Modus (ohne Technikkenntnisse)

Für Leute, die weder Linux noch die Web-Oberfläche anfassen möchten: einen
USB-Stick so vorbereiten und einstecken – beim Einschalten übernimmt der Stick
automatisch die Wiedergabe.

**So wird der Stick vorbereitet** (FAT32 oder exFAT formatiert):

```
USB-Stick/
├─ Videos/
│  ├─ 001.mp4        ← Videos in Abspielreihenfolge benennen
│  ├─ 002.mp4
│  ├─ 003.mp4
│  └─ loop.mp4       ← optional: läuft in Dauerschleife zwischen den Videos
└─ beampi.txt        ← Wartezeit für den Auto-Trigger
```

Inhalt von **`beampi.txt`** (legt fest, wie lange zwischen zwei Videos gewartet wird):

```
minuten=1
sekunden=30
```

Beim Einschalten gilt dann: Der `loop.mp4` läuft in Dauerschleife (ohne
`loop.mp4` bleibt der Hintergrund schwarz). Alle 1 min 30 s wird automatisch das
nächste Video aus `Videos/` abgespielt – der Reihe nach, danach wieder von vorn.
Fehlt `beampi.txt`, gilt eine Wartezeit von 30 Sekunden.

Der Stick wird nur **beim Systemstart** berücksichtigt und nur **schreibgeschützt**
gelesen (die Videos werden nicht verändert). Steckt kein Stick, läuft BeamPi ganz
normal mit den gespeicherten Playlists. Zum Zurückwechseln: Stick abziehen und
den Pi neu starten.

## Anmeldung

Die Web-UI ist passwortgeschützt. Erstanmeldung: Benutzer `admin`,
Passwort `beampi` – danach wird ein Passwortwechsel erzwungen. Die Sitzung
bleibt 180 Tage gespeichert (Cookie). Passwort später ändern: Einstellungen →
„Passwort ändern".

**Passwort vergessen** – auf dem Pi im Projektverzeichnis (`/opt/beampi`):

```bash
npm run set-password -- "MeinNeuesGeheim"   # neues Passwort direkt setzen
npm run reset-password                       # zurück auf admin/beampi (Zwangswechsel)
```

Beides beendet alle offenen Sitzungen und braucht keinen Server-Neustart.
Alternativ schlicht `data/auth.json` löschen und den Dienst neu starten –
das setzt ebenfalls auf admin/beampi zurück.

**Ohne Anmeldung erreichbar** bleiben die Maschinen-Endpunkte für
Trigger-Hardware: `/api/trigger` und `/webhook/<playlist>`.

## HTTP-API

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| GET/POST | `/api/trigger` | Nächstes Video triggern, optional `?playlist=Name` |
| POST | `/webhook/<playlist>` | Playlist starten und sofort erstes Video triggern |
| GET | `/api/status` | Player-Status + aktive Playlist + Fortschritt |
| GET | `/api/player/position` | Abspielposition des laufenden Videos (von mpv) |
| GET | `/api/state` | Kompletter Zustand (Playlists, Settings, Status) |
| GET | `/api/events` | Server-Sent-Events-Stream mit Live-Status |
| GET | `/api/playlists` | Alle Playlists |
| POST | `/api/playlists` | Playlist anlegen `{name, loop_video, videos}` |
| PUT | `/api/playlists/<name>` | Playlist ändern |
| DELETE | `/api/playlists/<name>` | Playlist löschen |
| POST | `/api/playlists/<name>/duplicate` | Playlist duplizieren (optional `{name}`) |
| POST | `/api/playlists/<name>/start` | Playlist aktivieren |
| GET | `/api/videos` | Video-Bibliothek (Liste, Baum, Größen/Dauern, freier Speicher) |
| GET | `/api/thumbs/<pfad>` | Thumbnail eines Videos (wird on-demand erzeugt) |
| DELETE | `/api/files` | Videodatei löschen `{path}` |
| POST | `/api/files/rename` | Datei umbenennen/verschieben `{from, to}` – Playlists ziehen mit |
| DELETE | `/api/folders` | Leeren Ordner löschen `{path}` |
| GET | `/videos/<pfad>` | Videodatei streamen (Range-Support) |
| GET/PUT | `/api/settings` | Einstellungen lesen/schreiben |
| PUT | `/api/volume` | Lautstärke/Stumm setzen `{volume, muted}` |
| PUT | `/api/auto-trigger` | Auto-Trigger setzen `{enabled, interval_s}` |
| GET | `/api/audio-devices` | Verfügbare mpv-Audio-Ausgänge auflisten |
| POST | `/api/folders` | Ordner anlegen `{path}` |
| POST | `/api/upload` | Videos hochladen (multipart, Feld `video_files`) |

## Installation auf dem Raspberry Pi

Voraussetzungen: Raspberry Pi OS (Desktop), Node.js ≥ 24, mpv.

```bash
sudo apt install -y mpv
sudo mkdir -p /opt/beampi && sudo chown pi:pi /opt/beampi
# Projektdateien nach /opt/beampi kopieren, dann:
cd /opt/beampi && npm install --omit=dev
sudo cp deploy/beampi.service deploy/beampi-usb.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now beampi-usb.service   # USB-Stick-Modus (mountet vor BeamPi)
sudo systemctl enable --now beampi
```

`beampi-usb.service` hängt einen vorbereiteten USB-Stick (siehe oben) vor dem
Start schreibgeschützt nach `/media/beampi-usb` ein. Ohne Stick passiert nichts.

Web-UI: `http://<pi-ip>:8080`

Konfiguration über Umgebungsvariablen: `PORT` (Standard 8080),
`BEAMPI_DATA_DIR` (Standard `./data`), `BEAMPI_VIDEO_DIR`
(Standard-Videoverzeichnis `/opt/beampi/videos`).

## Deployment

`./deploy.sh` pusht zu GitHub und synchronisiert per rsync auf den Pi.
Der Dienst wird nur neu gestartet, wenn sich Server-Code geändert hat —
reine UI-Änderungen laufen ohne Unterbrechung der Wiedergabe ein.
`./deploy.sh --no-push` überspringt den GitHub-Push.

Das SSH-Passwort liest das Skript aus `.deploy-pass` (nicht im Repo) oder
`$BEAMPI_SSH_PASS`; mit eingerichtetem SSH-Key braucht es gar keins.
Host/Pfad/Port sind per `BEAMPI_HOST`, `BEAMPI_PATH`, `BEAMPI_PORT` übersteuerbar.
