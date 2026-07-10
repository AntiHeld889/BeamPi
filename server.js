import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import multer from 'multer';

import { Storage } from './src/storage.js';
import { SettingsManager } from './src/settings.js';
import { VideoLibrary, isVideoFile } from './src/videos.js';
import { MediaMeta } from './src/media.js';
import { Auth, LoginThrottle, SESSION_MAX_AGE_S } from './src/auth.js';
import { Player, VideoNotFoundError } from './src/player.js';
import { GpioManager } from './src/gpio-manager.js';
import { detectUsbShow } from './src/usb.js';
import { setSystemVolume } from './src/audio.js';
import { resolveContainedPath } from './src/paths.js';
import { parseBoolean } from './src/validation.js';
import { createUploadStorage, sanitizeFilename } from './src/upload-storage.js';
import {
  readVersion,
  compareVersions,
  fetchLatestVersion,
  startSelfUpdate,
  isUpdating,
} from './src/updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.BEAMPI_DATA_DIR || path.join(__dirname, 'data');
const TRIGGER_TOKEN = (process.env.BEAMPI_TRIGGER_TOKEN || '').trim();
const VERSION = readVersion(__dirname);

// Zustand ---------------------------------------------------------------------

const storage = new Storage(DATA_DIR);
const settings = new SettingsManager(storage);
const playlists = storage.loadPlaylists();
const library = new VideoLibrary(() => settings.getVideoDirectory());
const media = new MediaMeta(DATA_DIR, () => settings.getVideoDirectory());

/** Relativen Pfad sicher ins Videoverzeichnis auflösen (oder null). */
function resolveInVideoDir(relativePath) {
  return resolveContainedPath(settings.getVideoDirectory(), relativePath);
}

function resolveChildInVideoDir(relativePath) {
  const absolute = resolveInVideoDir(relativePath);
  if (!absolute) return null;
  return absolute === settings.getVideoDirectory() ? null : absolute;
}

function rejectUsbFileMutation(res) {
  if (!settings.hasUsbOverrides()) return false;
  res.status(409).json({
    status: 'error',
    message: 'Im USB-Stick-Modus sind Dateiänderungen gesperrt.',
  });
  return true;
}

let activePlaylist = null;
let activeIndex = 0;

// USB-Stick-Modus: Beim Start kann ein vorbereiteter USB-Stick die Bühne
// übernehmen (Ordner "Videos" + beampi.txt). Die daraus erzeugte Playlist
// lebt nur im Speicher und wird nicht nach data/playlists.json geschrieben.
const USB_PLAYLIST_NAME = 'USB-Stick';
let usbMode = false;

const player = new Player({
  videoDir: settings.getVideoDirectory(),
  getAudioDevice: () => settings.getAudioOutput(),
  getStartWebhookUrl: () => settings.getTriggerStartWebhook(),
  getEndWebhookUrl: () => settings.getTriggerEndWebhook(),
});

/** Gespeicherte Lautstärke/Mute auf den System-Mixer (ALSA) anwenden. */
function applySystemVolume() {
  setSystemVolume(settings.getVolume(), settings.getMuted());
}

// GPIO-Taster: jede Playlist kann einen eigenen Pin definieren. Ein Druck wirkt
// als „Weiter"-Trigger für GENAU diese Playlist – ist sie nicht aktiv, wird sie
// erst aktiviert, dann das nächste Video getriggert. Während ein Trigger-Video
// läuft, wird der Druck ignoriert (gleicher Lockout wie der Trigger-Button).
const gpio = new GpioManager((playlistName) => {
  const status = player.getStatus();
  if (status.mode === 'trigger' || status.queued > 0) {
    console.log(`GPIO: Taster für „${playlistName}" ignoriert – es läuft bereits ein Video.`);
    return;
  }
  if (activePlaylist !== playlistName) {
    const started = startPlaylist(playlistName);
    if (!started.ok) {
      console.warn(`GPIO: Playlist „${playlistName}" wurde nicht gefunden.`);
      return;
    }
  }
  const result = triggerNext();
  if (result.ok) {
    console.log(`GPIO: Taster für „${playlistName}" – nächstes Video getriggert.`);
  } else {
    console.warn(`GPIO: Taster für „${playlistName}", aber kein Trigger möglich: ${result.error}`);
  }
});

/** Pin→Playlist-Zuordnung aus allen Playlists an den GPIO-Manager geben. */
function applyGpioBindings() {
  const bindings = [];
  for (const playlist of playlists.values()) {
    if (playlist.name === USB_PLAYLIST_NAME) continue;
    if (Number.isInteger(playlist.gpio_pin)) {
      bindings.push({ pin: playlist.gpio_pin, playlist: playlist.name });
    }
  }
  gpio.apply(bindings, settings.getGpioDebounceMs());
}

// Auto-Trigger: Countdown läuft nur, solange KEIN Video spielt. Er startet
// erst neu, wenn das (auto, manuell oder per GPIO getriggerte) Video zu Ende
// ist – kein fester Takt, keine Warteschlange.
let autoTriggerTimer = null;
let autoTriggerNextAt = null;

function autoTriggerSnapshot() {
  return {
    enabled: settings.getAutoTriggerEnabled(),
    interval_s: settings.getAutoTriggerIntervalS(),
    next_at: autoTriggerNextAt,
  };
}

function cancelAutoTriggerCountdown() {
  clearTimeout(autoTriggerTimer);
  autoTriggerTimer = null;
  autoTriggerNextAt = null;
}

function scheduleAutoTrigger() {
  cancelAutoTriggerCountdown();
  if (!settings.getAutoTriggerEnabled()) return;
  const status = player.getStatus();
  // Solange ein Trigger-Video läuft (oder ansteht), wartet der Countdown.
  if (status.mode === 'trigger' || status.queued > 0) return;
  const intervalMs = settings.getAutoTriggerIntervalS() * 1000;
  autoTriggerNextAt = Date.now() + intervalMs;
  autoTriggerTimer = setTimeout(() => {
    autoTriggerTimer = null;
    autoTriggerNextAt = null;
    const result = triggerNext();
    if (result.ok) {
      console.log('Auto-Trigger: nächstes Video gestartet.');
    } else {
      // Kein Video möglich (z. B. keine aktive Playlist) – später erneut.
      scheduleAutoTrigger();
      broadcastState();
    }
  }, intervalMs);
}

function applyAutoTrigger() {
  scheduleAutoTrigger();
  broadcastState();
}

function savePlaylists() {
  // Die flüchtige USB-Playlist nie auf die Platte schreiben.
  if (playlists.has(USB_PLAYLIST_NAME)) {
    const persistent = new Map(playlists);
    persistent.delete(USB_PLAYLIST_NAME);
    storage.savePlaylists(persistent);
  } else {
    storage.savePlaylists(playlists);
  }
}

function getActiveProgress() {
  if (!activePlaylist) return null;
  const playlist = playlists.get(activePlaylist);
  if (!playlist || playlist.videos.length === 0) return null;
  const total = playlist.videos.length;
  const next = activeIndex % total;
  return {
    playlist_name: activePlaylist,
    next_video_index: next + 1,
    total_videos: total,
    next_video: playlist.videos[next],
  };
}

function serializePlaylists() {
  const progress = getActiveProgress();
  return [...playlists.values()]
    // Die flüchtige USB-Playlist nicht in der Web-UI anbieten (nicht editierbar)
    .filter((playlist) => playlist.name !== USB_PLAYLIST_NAME)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map((playlist) => ({
      name: playlist.name,
      loop_video: playlist.loop_video,
      videos: playlist.videos,
      gpio_pin: Number.isInteger(playlist.gpio_pin) ? playlist.gpio_pin : null,
      is_active: playlist.name === activePlaylist,
      progress: progress && progress.playlist_name === playlist.name ? progress : null,
    }));
}

/** @returns {{ok: boolean, warning?: string}} */
function startPlaylist(name) {
  const playlist = playlists.get(name);
  if (!playlist) return { ok: false };
  activePlaylist = name;
  activeIndex = 0;
  let warning;
  try {
    player.setLoopVideo(playlist.loop_video);
  } catch (err) {
    warning =
      err instanceof VideoNotFoundError
        ? 'Loop-Video wurde nicht gefunden.'
        : `Ungültiger Pfad für Loop-Video: ${err.message}`;
    player.setLoopVideo(null);
  }
  return { ok: true, warning };
}

// Signatur des zuletzt erkannten USB-Sticks (erkennt Stick-Wechsel im Watcher)
let lastUsbSignature = null;

async function detectUsbShowSafe() {
  try {
    return await detectUsbShow();
  } catch (err) {
    console.warn(`USB-Erkennung fehlgeschlagen: ${err.message}`);
    return null;
  }
}

/**
 * Stellt den Normalbetrieb her: Auto-Start-Playlist starten, sonst Leerlauf.
 * Bereinigt eine tote Auto-Start-Referenz. Wird beim Boot UND beim Beenden des
 * USB-Modus genutzt, damit beide Pfade denselben Zustand herstellen.
 */
function applyAutoStartPlaylist() {
  const autoStart = settings.getAutoStartPlaylist();
  if (autoStart && startPlaylist(autoStart).ok) {
    console.log(`Auto-Start: Playlist "${autoStart}" aktiviert.`);
    return;
  }
  if (autoStart) {
    console.warn(`Auto-Start-Playlist "${autoStart}" wurde nicht gefunden.`);
    settings.setAutoStartPlaylist(null);
  }
  activePlaylist = null;
  activeIndex = 0;
  player.setLoopVideo(null);
}

/** Inhaltskennung des Sticks – ändert sich, wenn ein anderer Stick steckt. */
function usbSignature(show) {
  return JSON.stringify({ d: show.videosDir, v: show.videos, l: show.loopVideo, i: show.intervalS });
}

/** USB-Show aktivieren: Videoverzeichnis + Auto-Trigger + flüchtige Playlist. */
function startUsbShow(show) {
  // Videoverzeichnis + Auto-Trigger zur Laufzeit auf den Stick umbiegen.
  // Ohne Trigger-Videos (nur loop.mp4) läuft reiner Loop – kein Auto-Trigger,
  // sonst würde der Timer endlos ins Leere feuern.
  settings.applyUsbOverrides({
    videoDirectory: show.videosDir,
    autoTriggerEnabled: show.videos.length > 0,
    autoTriggerIntervalS: show.intervalS,
  });
  player.setVideoDirectory(show.videosDir);

  // Flüchtige Playlist aus den Stick-Videos aufbauen und aktivieren
  playlists.set(USB_PLAYLIST_NAME, {
    name: USB_PLAYLIST_NAME,
    loop_video: show.loopVideo,
    videos: show.videos,
    gpio_pin: null,
  });
  usbMode = true;
  lastUsbSignature = usbSignature(show);
  startPlaylist(USB_PLAYLIST_NAME);

  const mins = Math.floor(show.intervalS / 60);
  const secs = show.intervalS % 60;
  console.log(
    `USB-Stick erkannt (${show.root}): ${show.videos.length} Video(s), ` +
      `Loop ${show.loopVideo ? `„${show.loopVideo}"` : 'schwarz'}, ` +
      `Auto-Trigger alle ${mins} min ${secs} s` +
      `${show.configFound ? '' : ' (beampi.txt fehlt – Standard 30 s)'}.`
  );
}

/** USB-Show beenden und in den Normalbetrieb zurückkehren. */
function stopUsbShow() {
  playlists.delete(USB_PLAYLIST_NAME);
  settings.clearUsbOverrides();
  usbMode = false;
  lastUsbSignature = null;
  // setVideoDirectory bricht einen evtl. noch laufenden Stick-Trigger ab und
  // löst den Player vom (ausgehängten) Stick-Verzeichnis – danach Normalbetrieb.
  player.setVideoDirectory(settings.getVideoDirectory());
  applyAutoStartPlaylist();
  applyAutoTrigger();
  broadcastState();
  console.log('USB-Stick entfernt – zurück im Normalbetrieb.');
}

/** Beim Start: steckt ein vorbereiteter Stick, übernimmt er die Wiedergabe. */
async function tryStartUsbShow() {
  const show = await detectUsbShowSafe();
  if (!show) return false;
  startUsbShow(show);
  return true;
}

/**
 * Hotplug-Watcher: erkennt zur Laufzeit, ob ein vorbereiteter USB-Stick
 * dazugekommen, gewechselt oder entfernt wurde, und schaltet entsprechend um
 * (kein Neustart nötig). Das eigentliche Mounten/Aushängen erledigt die
 * udev-Regel (deploy/99-beampi-usb.rules) auf Root-Ebene.
 *
 * Re-entrancy-Schutz: läuft eine (async) Erkennung noch – etwa weil ein
 * langsamer Mount sie aufhält –, überspringt der nächste Tick, statt sich zu
 * stapeln.
 */
let usbReconciling = false;
async function reconcileUsb() {
  if (usbReconciling) return;
  usbReconciling = true;
  try {
    const show = await detectUsbShowSafe();
    if (show) {
      if (!usbMode || usbSignature(show) !== lastUsbSignature) {
        startUsbShow(show); // neu eingesteckt bzw. anderer Stick/Inhalt
      }
    } else if (usbMode) {
      stopUsbShow(); // Stick entfernt
    }
  } finally {
    usbReconciling = false;
  }
}

/** @returns {{ok: boolean, error?: string}} */
function triggerNext() {
  if (!activePlaylist) return { ok: false, error: 'Keine aktive Playlist.' };
  // Solange ein Trigger-Video läuft (oder eins ansteht), KEIN weiterer Trigger.
  // Der Trigger darf erst wieder auslösen, wenn das laufende Video zu Ende ist
  // (dann läuft wieder Loop/Stille). Gilt für alle Quellen: Web, GPIO, Webhook,
  // Auto-Trigger.
  const status = player.getStatus();
  if (status.mode === 'trigger' || status.queued > 0) {
    return { ok: false, error: 'Es läuft bereits ein Video.' };
  }
  const playlist = playlists.get(activePlaylist);
  if (!playlist || playlist.videos.length === 0) {
    return { ok: false, error: 'Die aktive Playlist enthält keine Videos.' };
  }
  const video = playlist.videos[activeIndex % playlist.videos.length];
  activeIndex = (activeIndex + 1) % playlist.videos.length;
  try {
    player.enqueue(video);
  } catch (err) {
    const message =
      err instanceof VideoNotFoundError
        ? `Video ${video} wurde nicht gefunden.`
        : `Ungültiger Videopfad: ${err.message}`;
    broadcastState(); // der Index hat sich trotzdem bewegt – Clients informieren
    return { ok: false, error: message };
  }
  return { ok: true };
}

function deletePlaylist(name) {
  if (!playlists.delete(name)) return false;
  if (activePlaylist === name) {
    activePlaylist = null;
    activeIndex = 0;
    player.setLoopVideo(null);
  }
  if (settings.getAutoStartPlaylist() === name) {
    settings.setAutoStartPlaylist(null);
  }
  savePlaylists();
  applyGpioBindings(); // gelöschter Pin freigeben
  broadcastState();
  return true;
}

function duplicatePlaylist(name, requestedName) {
  if (name === USB_PLAYLIST_NAME) {
    throw new Error('Die USB-Stick-Playlist kann nicht dupliziert werden.');
  }
  const original = playlists.get(name);
  if (!original) {
    const err = new Error('Playlist wurde nicht gefunden.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  let candidate;
  if (requestedName != null && requestedName !== '') {
    candidate = String(requestedName).trim();
    if (!candidate) throw new Error('Der neue Playlist-Name darf nicht leer sein.');
    if (candidate.includes('/')) throw new Error('Der Name darf keinen Schrägstrich enthalten.');
    if (candidate === USB_PLAYLIST_NAME) throw new Error('Dieser Name ist für den USB-Stick-Modus reserviert.');
    if (playlists.has(candidate)) throw new Error('Eine Playlist mit diesem Namen existiert bereits.');
  } else {
    const base = `${original.name} Kopie`;
    candidate = base;
    let suffix = 2;
    while (playlists.has(candidate)) candidate = `${base} ${suffix++}`;
  }
  // gpio_pin NICHT mitkopieren – ein Pin darf nur einer Playlist gehören.
  const copy = { name: candidate, loop_video: original.loop_video, videos: [...original.videos], gpio_pin: null };
  playlists.set(candidate, copy);
  savePlaylists();
  broadcastState();
  return copy;
}

/**
 * Eine Playlist umbenennen und alle Referenzen mitführen (aktive Playlist,
 * Auto-Start). Der Name ist der Schlüssel in Map/JSON.
 */
function renamePlaylist(name, requestedName) {
  if (name === USB_PLAYLIST_NAME) {
    throw new Error('Die USB-Stick-Playlist kann nicht umbenannt werden.');
  }
  const playlist = playlists.get(name);
  if (!playlist) {
    const err = new Error('Playlist wurde nicht gefunden.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const newName = String(requestedName ?? '').trim();
  if (!newName) throw new Error('Der neue Playlist-Name darf nicht leer sein.');
  if (newName === name) return playlist; // unverändert
  if (newName.includes('/')) throw new Error('Der Name darf keinen Schrägstrich enthalten.');
  if (newName === USB_PLAYLIST_NAME) throw new Error('Dieser Name ist für den USB-Stick-Modus reserviert.');
  if (playlists.has(newName)) throw new Error('Eine Playlist mit diesem Namen existiert bereits.');

  playlist.name = newName;
  playlists.delete(name);
  playlists.set(newName, playlist);

  // Referenzen mitführen, damit nichts ins Leere zeigt
  if (activePlaylist === name) activePlaylist = newName;
  if (settings.getAutoStartPlaylist() === name) settings.setAutoStartPlaylist(newName);

  savePlaylists();
  applyGpioBindings(); // Pin-Zuordnung zeigt jetzt auf den neuen Namen
  broadcastState();
  return playlist;
}

function validatePlaylistVideos(loopVideo, videos) {
  const known = new Set(library.list());
  if (loopVideo && !known.has(loopVideo)) {
    return `Loop-Video „${loopVideo}" wurde nicht gefunden.`;
  }
  for (const video of videos) {
    if (!known.has(video)) return `Video „${video}" wurde nicht gefunden.`;
  }
  return null;
}

/**
 * GPIO-Pin einer Playlist normalisieren. Leer/null = kein Pin.
 * @returns {number|null}
 * @throws {Error} bei ungültigem Pin (Nachricht für die API)
 */
function parseGpioPin(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const pin = Number(value);
  if (!Number.isInteger(pin) || pin < 0 || pin > 27) {
    throw new Error('GPIO-Pin muss eine BCM-Nummer zwischen 0 und 27 sein.');
  }
  return pin;
}

/**
 * Prüft, ob der Pin schon von einer ANDEREN Playlist belegt ist (ein Pin darf
 * nur einer Playlist zugeordnet sein).
 * @returns {string|null} Name der kollidierenden Playlist oder null
 */
function gpioPinConflict(pin, exceptName) {
  if (pin === null) return null;
  for (const playlist of playlists.values()) {
    if (playlist.name === exceptName || playlist.name === USB_PLAYLIST_NAME) continue;
    if (playlist.gpio_pin === pin) return playlist.name;
  }
  return null;
}

// Server-Sent Events ------------------------------------------------------------

const sseClients = new Set();

function stateSnapshot() {
  return {
    status: player.getStatus(),
    active_playlist: activePlaylist,
    active_progress: getActiveProgress(),
    volume: settings.getVolume(),
    muted: settings.getMuted(),
    auto_trigger: autoTriggerSnapshot(),
    usb_mode: usbMode,
    version: VERSION,
    now: Date.now(), // für driftfreie Countdown-Anzeige im Client
  };
}

function broadcastState() {
  const data = `data: ${JSON.stringify(stateSnapshot())}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      // Socket bereits hart getrennt – entfernen, bevor er weitere Broadcasts wirft
      sseClients.delete(client);
    }
  }
}

player.on('status', (status) => {
  if (settings.getAutoTriggerEnabled()) {
    if (status.mode === 'trigger' || status.queued > 0) {
      // Video läuft – Countdown anhalten, bis es zu Ende ist
      cancelAutoTriggerCountdown();
    } else if (!autoTriggerTimer) {
      // Video ist zu Ende (oder Loop läuft wieder) – Countdown neu starten
      scheduleAutoTrigger();
    }
  }
  broadcastState();
});

// Express ------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// 2 MB statt der 100-kB-Voreinstellung – Playlists mit sehr vielen Videos
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Anmeldung -----------------------------------------------------------------------

const auth = new Auth(DATA_DIR);
const loginThrottle = new LoginThrottle();
const SESSION_COOKIE = 'beampi_session';

function sessionTokenFrom(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function triggerTokenFrom(req) {
  const header = String(req.headers['x-beampi-trigger-token'] ?? '').trim();
  if (header) return header;
  const authorization = String(req.headers.authorization ?? '').trim();
  if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();
  return String(req.query?.token ?? req.body?.token ?? '').trim();
}

function hasTriggerAccess(req) {
  if (!TRIGGER_TOKEN) return true;
  if (triggerTokenFrom(req) === TRIGGER_TOKEN) return true;
  const token = sessionTokenFrom(req);
  return Boolean(token && auth.validateSession(token));
}

function requireTriggerAccess(req, res) {
  if (hasTriggerAccess(req)) return true;
  res.status(401).json({ status: 'error', message: 'Trigger-Token erforderlich.' });
  return false;
}

// Diese Pfade bleiben ohne Anmeldung erreichbar: Login selbst sowie die
// Maschinen-Endpunkte für Trigger-Hardware (ESPs, Taster-Module, Webhooks).
function isPublicPath(req) {
  if (req.path === '/api/login' || req.path === '/api/session') return true;
  if (req.path === '/api/trigger') return true;
  if (req.path.startsWith('/webhook/')) return true;
  return false;
}

app.use((req, res, next) => {
  const needsAuth = req.path.startsWith('/api/') || req.path.startsWith('/videos/');
  if (!needsAuth || isPublicPath(req)) return next();
  const token = sessionTokenFrom(req);
  if (token && auth.validateSession(token)) {
    req.sessionToken = token;
    return next();
  }
  res.status(401).json({ status: 'error', message: 'Anmeldung erforderlich.' });
});

app.get('/api/session', (req, res) => {
  const token = sessionTokenFrom(req);
  const authenticated = Boolean(token && auth.validateSession(token));
  res.json({
    authenticated,
    username: authenticated ? auth.username : null,
    must_change_password: authenticated ? auth.mustChangePassword : false,
  });
});

app.post('/api/login', (req, res) => {
  const ip = req.socket.remoteAddress ?? 'unbekannt';
  if (!loginThrottle.check(ip)) {
    return res.status(429).json({ status: 'error', message: 'Zu viele Fehlversuche – bitte 5 Minuten warten.' });
  }
  const { username, password } = req.body ?? {};
  if (!auth.verifyCredentials(username, password)) {
    loginThrottle.fail(ip);
    return res.status(401).json({ status: 'error', message: 'Benutzername oder Passwort falsch.' });
  }
  loginThrottle.succeed(ip);
  const token = auth.createSession();
  setSessionCookie(res, token);
  res.json({ status: 'ok', must_change_password: auth.mustChangePassword });
});

app.post('/api/logout', (req, res) => {
  auth.destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ status: 'ok' });
});

app.post('/api/password', (req, res) => {
  const { current_password: current, new_password: next } = req.body ?? {};
  if (!auth.verifyCredentials(auth.username, String(current ?? ''))) {
    return res.status(400).json({ status: 'error', message: 'Das aktuelle Passwort ist falsch.' });
  }
  const newPassword = String(next ?? '');
  if (newPassword.length < 6) {
    return res.status(400).json({ status: 'error', message: 'Das neue Passwort braucht mindestens 6 Zeichen.' });
  }
  if (newPassword === 'beampi') {
    return res.status(400).json({ status: 'error', message: 'Bitte ein anderes Passwort als das Standardpasswort wählen.' });
  }
  auth.setPassword(newPassword, req.sessionToken);
  res.json({ status: 'ok' });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(stateSnapshot())}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.get('/api/state', (req, res) => {
  res.json({
    ...stateSnapshot(),
    playlists: serializePlaylists(),
    settings: settings.toJSON(),
  });
});

app.get('/api/status', (req, res) => {
  res.json(stateSnapshot());
});

// Abspielposition für die Live-Vorschau (direkt von mpv abgefragt)
app.get('/api/player/position', async (req, res) => {
  const info = await player.getPlaybackInfo();
  res.json({ playback: info });
});

// Lautstärke (0–100) und/oder Stummschaltung – gespeichert und sofort angewendet
app.put('/api/volume', (req, res) => {
  const body = req.body ?? {};
  let muted = null;
  if (body.volume !== undefined) {
    const volume = Number(body.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      return res.status(400).json({ status: 'error', message: 'Lautstärke muss zwischen 0 und 100 liegen.' });
    }
  }
  if (body.muted !== undefined) {
    muted = parseBoolean(body.muted);
    if (muted === null) {
      return res.status(400).json({ status: 'error', message: 'Stummschaltung muss true oder false sein.' });
    }
  }
  settings.batchUpdate(() => {
    if (body.volume !== undefined) settings.setVolume(Number(body.volume));
    if (muted !== null) settings.setMuted(muted);
  });
  // Regler steuert die komplette System-(ALSA-)Lautstärke, nicht nur mpv.
  applySystemVolume();
  broadcastState();
  res.json({ status: 'ok', volume: settings.getVolume(), muted: settings.getMuted() });
});

// Auto-Trigger ein/aus + Intervall (1 s bis 60 min 60 s)
app.put('/api/auto-trigger', (req, res) => {
  if (settings.hasUsbOverrides()) {
    return res.status(409).json({ status: 'error', message: 'Im USB-Stick-Modus steuert der Stick (beampi.txt) den Auto-Trigger.' });
  }
  const body = req.body ?? {};
  let enabled = null;
  if (body.interval_s !== undefined) {
    const seconds = Number(body.interval_s);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3660) {
      return res.status(400).json({
        status: 'error',
        message: 'Intervall muss zwischen 1 Sekunde und 60 Minuten 60 Sekunden liegen.',
      });
    }
  }
  if (body.enabled !== undefined) {
    enabled = parseBoolean(body.enabled);
    if (enabled === null) {
      return res.status(400).json({ status: 'error', message: 'Auto-Trigger muss true oder false sein.' });
    }
  }
  settings.batchUpdate(() => {
    if (body.interval_s !== undefined) settings.setAutoTriggerIntervalS(Number(body.interval_s));
    if (enabled !== null) settings.setAutoTriggerEnabled(enabled);
  });
  applyAutoTrigger();
  res.json({ status: 'ok', auto_trigger: autoTriggerSnapshot() });
});

// Verfügbare Audio-Geräte (von mpv erfragt)
app.get('/api/audio-devices', async (req, res) => {
  const devices = await player.getAudioDeviceList();
  res.json({ devices, current: settings.getAudioOutput() });
});

// Installierte Version + Abgleich mit dem aktuellen Stand auf GitHub.
app.get('/api/version', async (req, res) => {
  const result = { current: VERSION, latest: null, update_available: false, updating: isUpdating() };
  try {
    const latest = await fetchLatestVersion();
    result.latest = latest;
    result.update_available = compareVersions(latest, VERSION) > 0;
  } catch (err) {
    result.error = `Konnte GitHub nicht erreichen: ${err.message}`;
  }
  res.json(result);
});

// Self-Update anstoßen: zieht den neuesten Stand und startet den Dienst neu.
app.post('/api/update', (req, res) => {
  if (isUpdating()) {
    return res.status(409).json({ status: 'error', message: 'Es läuft bereits ein Update.' });
  }
  try {
    startSelfUpdate(__dirname);
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
  // Antwort sofort senden – der Neustart erfolgt gleich im Hintergrund.
  res.json({ status: 'ok', message: 'Update gestartet – BeamPi startet in Kürze neu.' });
});

app.get('/api/playlists', (req, res) => {
  res.json({ playlists: serializePlaylists() });
});

app.post('/api/playlists', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const loopVideo = req.body?.loop_video || null;
  const videos = Array.isArray(req.body?.videos) ? req.body.videos.map(String) : [];
  if (!name) return res.status(400).json({ status: 'error', message: 'Bitte einen Namen für die Playlist eingeben.' });
  if (name.includes('/')) return res.status(400).json({ status: 'error', message: 'Der Name darf keinen Schrägstrich enthalten.' });
  if (name === USB_PLAYLIST_NAME) return res.status(409).json({ status: 'error', message: 'Dieser Name ist für den USB-Stick-Modus reserviert.' });
  if (playlists.has(name)) return res.status(409).json({ status: 'error', message: 'Eine Playlist mit diesem Namen existiert bereits.' });
  const invalid = validatePlaylistVideos(loopVideo, videos);
  if (invalid) return res.status(400).json({ status: 'error', message: invalid });
  let gpioPin;
  try {
    gpioPin = parseGpioPin(req.body?.gpio_pin);
  } catch (err) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
  const conflict = gpioPinConflict(gpioPin, name);
  if (conflict) return res.status(409).json({ status: 'error', message: `GPIO-Pin ${gpioPin} ist bereits der Playlist „${conflict}" zugeordnet.` });
  const playlist = { name, loop_video: loopVideo, videos, gpio_pin: gpioPin };
  playlists.set(name, playlist);
  savePlaylists();
  applyGpioBindings();
  broadcastState();
  res.status(201).json({ status: 'ok', playlist });
});

app.put('/api/playlists/:name', (req, res) => {
  if (req.params.name === USB_PLAYLIST_NAME) {
    return res.status(409).json({ status: 'error', message: 'Die USB-Stick-Playlist kann nicht bearbeitet werden.' });
  }
  const playlist = playlists.get(req.params.name);
  if (!playlist) return res.status(404).json({ status: 'error', message: 'Playlist wurde nicht gefunden.' });
  const loopVideo = req.body?.loop_video || null;
  const videos = Array.isArray(req.body?.videos) ? req.body.videos.map(String) : [];
  const invalid = validatePlaylistVideos(loopVideo, videos);
  if (invalid) return res.status(400).json({ status: 'error', message: invalid });
  let gpioPin = playlist.gpio_pin ?? null;
  if (req.body?.gpio_pin !== undefined) {
    try {
      gpioPin = parseGpioPin(req.body.gpio_pin);
    } catch (err) {
      return res.status(400).json({ status: 'error', message: err.message });
    }
    const conflict = gpioPinConflict(gpioPin, playlist.name);
    if (conflict) return res.status(409).json({ status: 'error', message: `GPIO-Pin ${gpioPin} ist bereits der Playlist „${conflict}" zugeordnet.` });
  }
  playlist.loop_video = loopVideo;
  playlist.videos = videos;
  playlist.gpio_pin = gpioPin;
  savePlaylists();
  applyGpioBindings();
  let warning;
  if (activePlaylist === playlist.name) {
    try {
      player.setLoopVideo(playlist.loop_video);
    } catch {
      warning = 'Loop-Video wurde nicht gefunden.';
      player.setLoopVideo(null);
    }
  }
  broadcastState();
  res.json({ status: 'ok', playlist, warning });
});

app.delete('/api/playlists/:name', (req, res) => {
  if (req.params.name === USB_PLAYLIST_NAME) {
    return res.status(409).json({ status: 'error', message: 'Die USB-Stick-Playlist kann nicht gelöscht werden.' });
  }
  if (!deletePlaylist(req.params.name)) {
    return res.status(404).json({ status: 'error', message: 'Playlist wurde nicht gefunden.' });
  }
  res.json({ status: 'ok' });
});

app.post('/api/playlists/:name/duplicate', (req, res) => {
  const requestedName = req.body?.name ?? req.body?.new_name ?? null;
  try {
    const playlist = duplicatePlaylist(req.params.name, requestedName);
    res.json({ status: 'ok', playlist });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

app.post('/api/playlists/:name/rename', (req, res) => {
  try {
    const playlist = renamePlaylist(req.params.name, req.body?.name);
    res.json({ status: 'ok', playlist });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

app.post('/api/playlists/:name/start', (req, res) => {
  const result = startPlaylist(req.params.name);
  if (!result.ok) return res.status(404).json({ status: 'error', message: 'Playlist wurde nicht gefunden.' });
  res.json({ status: 'ok', warning: result.warning });
});

// Trigger (kompatibel zum Original: GET und POST, optional mit Playlist-Name)
app.all('/api/trigger', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Methode nicht erlaubt' });
  }
  if (!requireTriggerAccess(req, res)) return;
  const playlistName =
    req.method === 'GET' ? req.query.playlist : req.body?.playlist ?? req.query.playlist;
  if (playlistName) {
    const name = String(playlistName);
    if (activePlaylist !== name) {
      const started = startPlaylist(name);
      if (!started.ok) return res.status(404).json({ status: 'error', message: 'Playlist nicht gefunden' });
    } else if (!playlists.has(name)) {
      return res.status(404).json({ status: 'error', message: 'Playlist nicht gefunden' });
    }
  }
  const result = triggerNext();
  if (!result.ok) return res.status(400).json({ status: 'error', message: result.error ?? 'Kein Video verfügbar' });
  res.json({ status: 'ok' });
});

// Eingehender Webhook: Playlist starten und sofort erstes Video triggern
app.post('/webhook/:name', (req, res) => {
  if (!requireTriggerAccess(req, res)) return;
  const started = startPlaylist(req.params.name);
  if (!started.ok) return res.status(404).json({ status: 'error', message: 'Playlist nicht gefunden' });
  const result = triggerNext();
  if (!result.ok) return res.status(400).json({ status: 'error', message: result.error ?? 'Kein Video verfügbar' });
  res.json({ status: 'ok' });
});

app.get('/api/videos', (req, res) => {
  const files = library.listDetailed();
  media.ensureDurations(files); // fehlende Dauern im Hintergrund ermitteln
  let disk = null;
  try {
    const stats = fs.statfsSync(settings.getVideoDirectory());
    disk = { free: stats.bsize * stats.bavail, total: stats.bsize * stats.blocks };
  } catch {
    /* statfs nicht verfügbar */
  }
  res.json({
    videos: files.map((file) => file.path),
    tree: library.tree(),
    folders: library.folders(), // alle Unterordner (auch leere) für Upload-Ziel
    files: files.map((file) => ({
      path: file.path,
      size: file.size,
      duration: media.durationFor(file.path, file.size, file.mtimeMs),
    })),
    disk,
  });
});

// Thumbnail eines Videos (wird beim ersten Zugriff per ffmpeg erzeugt)
app.get('/api/thumbs/*path', async (req, res) => {
  const relative = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
  if (!resolveInVideoDir(relative)) return res.status(400).end();
  const file = await media.thumbnail(relative);
  if (!file) return res.status(404).end();
  res.sendFile(file, { maxAge: '10m' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Videodatei löschen
app.delete('/api/files', (req, res) => {
  if (rejectUsbFileMutation(res)) return;
  const relative = String(req.body?.path ?? '').trim();
  if (!relative) return res.status(400).json({ status: 'error', message: 'Kein Dateipfad angegeben.' });
  const absolute = resolveInVideoDir(relative);
  if (!absolute) return res.status(400).json({ status: 'error', message: 'Der Pfad muss innerhalb des Videoverzeichnisses liegen.' });
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return res.status(404).json({ status: 'error', message: 'Datei wurde nicht gefunden.' });
  }
  if (!stat.isFile()) return res.status(400).json({ status: 'error', message: 'Der Pfad ist keine Datei.' });
  try {
    fs.rmSync(absolute);
  } catch (err) {
    return res.status(500).json({ status: 'error', message: `Löschen fehlgeschlagen: ${err.message}` });
  }
  library.invalidate();
  const referencedBy = [...playlists.values()]
    .filter((p) => p.loop_video === relative || p.videos.includes(relative))
    .map((p) => p.name);
  res.json({
    status: 'ok',
    warning: referencedBy.length
      ? `Achtung: Die Datei wird noch in ${referencedBy.length === 1 ? 'der Playlist' : 'den Playlists'} ${referencedBy.join(', ')} verwendet.`
      : undefined,
  });
});

// Videodatei umbenennen/verschieben – Playlist-Verweise ziehen automatisch mit
app.post('/api/files/rename', (req, res) => {
  if (rejectUsbFileMutation(res)) return;
  const from = String(req.body?.from ?? '').trim();
  const to = String(req.body?.to ?? '').trim();
  if (!from || !to) return res.status(400).json({ status: 'error', message: 'Quelle und Ziel angeben.' });
  if (!isVideoFile(to)) return res.status(400).json({ status: 'error', message: 'Das Ziel muss eine Video-Dateiendung behalten.' });
  const fromAbs = resolveInVideoDir(from);
  const toAbs = resolveInVideoDir(to);
  if (!fromAbs || !toAbs) return res.status(400).json({ status: 'error', message: 'Pfade müssen innerhalb des Videoverzeichnisses liegen.' });
  if (!fs.existsSync(fromAbs)) return res.status(404).json({ status: 'error', message: 'Datei wurde nicht gefunden.' });
  if (fs.existsSync(toAbs)) return res.status(409).json({ status: 'error', message: 'Am Zielpfad existiert bereits eine Datei.' });
  try {
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
  } catch (err) {
    return res.status(500).json({ status: 'error', message: `Umbenennen fehlgeschlagen: ${err.message}` });
  }
  library.invalidate();

  // Verweise in allen Playlists aktualisieren
  let updatedPlaylists = 0;
  for (const playlist of playlists.values()) {
    let touched = false;
    if (playlist.loop_video === from) {
      playlist.loop_video = to;
      touched = true;
    }
    playlist.videos = playlist.videos.map((v) => {
      if (v === from) {
        touched = true;
        return to;
      }
      return v;
    });
    if (touched) updatedPlaylists += 1;
  }
  if (updatedPlaylists > 0) savePlaylists();
  if (activePlaylist) {
    const playlist = playlists.get(activePlaylist);
    if (playlist?.loop_video === to) {
      try {
        player.setLoopVideo(to);
      } catch {
        /* Loop lädt beim nächsten Zyklus */
      }
    }
  }
  broadcastState();
  res.json({ status: 'ok', updated_playlists: updatedPlaylists });
});

// Leeren Ordner löschen
app.delete('/api/folders', (req, res) => {
  if (rejectUsbFileMutation(res)) return;
  const relative = String(req.body?.path ?? '').trim();
  if (!relative) return res.status(400).json({ status: 'error', message: 'Kein Ordner angegeben.' });
  const absolute = resolveChildInVideoDir(relative);
  if (!absolute) return res.status(400).json({ status: 'error', message: 'Der Pfad muss innerhalb des Videoverzeichnisses liegen.' });
  let entries;
  try {
    entries = fs.readdirSync(absolute);
  } catch {
    return res.status(404).json({ status: 'error', message: 'Ordner wurde nicht gefunden.' });
  }
  if (entries.length > 0) {
    return res.status(409).json({ status: 'error', message: 'Der Ordner ist nicht leer.' });
  }
  try {
    fs.rmdirSync(absolute);
  } catch (err) {
    return res.status(500).json({ status: 'error', message: `Löschen fehlgeschlagen: ${err.message}` });
  }
  library.invalidate();
  res.json({ status: 'ok' });
});

// Videodateien streamen (mit Range-Support für die Browser-Vorschau)
app.get('/videos/*path', (req, res) => {
  const relative = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
  const absolute = resolveInVideoDir(relative);
  if (!absolute) return res.status(400).end();
  res.sendFile(absolute, { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(err.status ?? 404).end();
  });
});

// Einstellungen -------------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  res.json({
    settings: settings.toJSON(),
    video_directory: settings.getVideoDirectory(),
    gpio: gpio.getStatus(),
  });
});

app.put('/api/settings', (req, res) => {
  const body = req.body ?? {};
  const warnings = [];

  // --- Erst ALLES validieren, dann anwenden – sonst bleiben bei einem
  // Fehler mittendrin halb übernommene Einstellungen zurück. ---------------
  if (typeof body.auto_start_playlist === 'string') {
    const name = body.auto_start_playlist.trim();
    if (name === USB_PLAYLIST_NAME) {
      return res.status(400).json({ status: 'error', message: 'Die USB-Stick-Playlist kann nicht als Auto-Start gesetzt werden.' });
    }
    if (name && !playlists.has(name)) {
      return res.status(400).json({ status: 'error', message: 'Die ausgewählte Playlist wurde nicht gefunden.' });
    }
  }
  if (body.gpio_debounce_ms !== undefined) {
    const debounce = Number(body.gpio_debounce_ms);
    if (!Number.isFinite(debounce) || debounce < 50 || debounce > 5000) {
      return res.status(400).json({ status: 'error', message: 'Entprellzeit muss zwischen 50 und 5000 ms liegen.' });
    }
  }

  // --- Anwenden und gemeinsam genau einmal persistieren -------------------
  const previousAudio = settings.getAudioOutput();
  let updatedVideoDirectory = null;

  try {
    settings.batchUpdate(() => {
      // Im USB-Modus liegt das Videoverzeichnis fest auf dem Stick – ein Schreiben
      // würde den Player mitten in der laufenden Show vom Stick wegreißen.
      if (typeof body.video_directory === 'string' && settings.hasUsbOverrides()) {
        warnings.push('Im USB-Stick-Modus ist das Videoverzeichnis fest vom Stick vorgegeben.');
      } else if (typeof body.video_directory === 'string') {
        updatedVideoDirectory = settings.setVideoDirectory(body.video_directory);
      }
      if (typeof body.audio_output === 'string') settings.setAudioOutput(body.audio_output);
      if (typeof body.trigger_start_webhook_url === 'string') settings.setTriggerStartWebhook(body.trigger_start_webhook_url);
      if (typeof body.trigger_end_webhook_url === 'string') settings.setTriggerEndWebhook(body.trigger_end_webhook_url);
      if (typeof body.auto_start_playlist === 'string') settings.setAutoStartPlaylist(body.auto_start_playlist.trim());
      if (body.gpio_debounce_ms !== undefined) settings.setGpioDebounceMs(Number(body.gpio_debounce_ms));
    });
  } catch (err) {
    return res.status(400).json({ status: 'error', message: err.message });
  }

  if (updatedVideoDirectory && updatedVideoDirectory !== player.videoDir) {
    player.setVideoDirectory(updatedVideoDirectory);
    library.invalidate();
    // Loop-Video der aktiven Playlist im neuen Verzeichnis wiederherstellen
    if (activePlaylist) {
      const playlist = playlists.get(activePlaylist);
      if (playlist) {
        try {
          player.setLoopVideo(playlist.loop_video);
        } catch {
          warnings.push('Loop-Video wurde im neuen Videoverzeichnis nicht gefunden.');
          player.setLoopVideo(null);
        }
      }
    }
  }

  if (settings.getAudioOutput() !== previousAudio) {
    player.restart();
    warnings.push('Audio-Gerät geändert – der Player wird neu gestartet.');
  }
  applyGpioBindings(); // ggf. geänderte Entprellung auf alle Playlist-Taster anwenden

  broadcastState();
  res.json({ status: 'ok', settings: settings.toJSON(), warnings, gpio: gpio.getStatus() });
});

app.post('/api/folders', (req, res) => {
  if (rejectUsbFileMutation(res)) return;
  const folderPath = String(req.body?.path ?? '').trim();
  if (!folderPath) return res.status(400).json({ status: 'error', message: 'Bitte einen Ordnernamen angeben.' });
  const target = resolveInVideoDir(folderPath);
  if (!target) {
    return res.status(400).json({ status: 'error', message: 'Der Ordnerpfad muss innerhalb des Videoverzeichnisses liegen.' });
  }
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: `Ordner konnte nicht erstellt werden: ${err.message}` });
  }
  library.invalidate();
  res.json({ status: 'ok' });
});

// Upload ---------------------------------------------------------------------------

const upload = multer({
  storage: createUploadStorage(() => settings.getVideoDirectory()),
  // Ungültige Dateien überspringen statt den ganzen Upload abzubrechen
  fileFilter: (req, file, cb) => {
    const name = sanitizeFilename(file.originalname);
    cb(null, Boolean(name) && isVideoFile(name));
  },
  limits: { fileSize: 8 * 1024 ** 3, files: 50 },
});

app.post('/api/upload', (req, res) => {
  if (rejectUsbFileMutation(res)) return;
  upload.array('video_files')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ status: 'error', message: err.message });
    }
    const saved = (req.files ?? []).map((file) =>
      path.relative(settings.getVideoDirectory(), file.path).split(path.sep).join('/')
    );
    if (saved.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Keine gültigen Videodateien ausgewählt.' });
    }
    library.invalidate();
    res.json({ status: 'ok', saved });
  });
});

// Start ------------------------------------------------------------------------------

applyGpioBindings();
applySystemVolume(); // gespeicherte Lautstärke auf den System-Mixer anwenden

// Steckt ein vorbereiteter USB-Stick, übernimmt er die Wiedergabe. Sonst
// greift der normale Auto-Start aus den gespeicherten Einstellungen.
if (!(await tryStartUsbShow())) {
  applyAutoStartPlaylist();
}
applyAutoTrigger();

// USB-Hotplug: alle 3 s prüfen, ob ein vorbereiteter Stick dazugekommen,
// gewechselt oder entfernt wurde – dann ohne Neustart umschalten.
const usbWatchTimer = setInterval(reconcileUsb, 3000);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`BeamPi läuft auf http://0.0.0.0:${PORT}`);
  console.log(`Videoverzeichnis: ${settings.getVideoDirectory()}`);
});

function shutdown() {
  clearInterval(usbWatchTimer);
  gpio.stop();
  player.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
