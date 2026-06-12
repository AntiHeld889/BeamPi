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
- HTTP-API kompatibel zum Original

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
| POST | `/api/folders` | Ordner anlegen `{path}` |
| POST | `/api/upload` | Videos hochladen (multipart, Feld `video_files`) |

## Installation auf dem Raspberry Pi

Voraussetzungen: Raspberry Pi OS (Desktop), Node.js ≥ 24, mpv.

```bash
sudo apt install -y mpv
sudo mkdir -p /opt/beampi && sudo chown pi:pi /opt/beampi
# Projektdateien nach /opt/beampi kopieren, dann:
cd /opt/beampi && npm install --omit=dev
sudo cp deploy/beampi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now beampi
```

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
