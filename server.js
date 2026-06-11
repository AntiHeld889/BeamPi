import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import multer from 'multer';

import { Storage } from './src/storage.js';
import { SettingsManager } from './src/settings.js';
import { VideoLibrary, isVideoFile } from './src/videos.js';
import { Player, VideoNotFoundError, InvalidVideoPathError } from './src/player.js';
import { GpioButton } from './src/gpio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.BEAMPI_DATA_DIR || path.join(__dirname, 'data');

// Zustand ---------------------------------------------------------------------

const storage = new Storage(DATA_DIR);
const settings = new SettingsManager(storage);
const playlists = storage.loadPlaylists();
const library = new VideoLibrary(() => settings.getVideoDirectory());

let activePlaylist = null;
let activeIndex = 0;

const player = new Player({
  videoDir: settings.getVideoDirectory(),
  getAudioDevice: () => settings.getAudioOutput(),
  getStartWebhookUrl: () => settings.getTriggerStartWebhook(),
  getEndWebhookUrl: () => settings.getTriggerEndWebhook(),
  getDrmMode: () => settings.getDrmMode(),
});

// GPIO-Taster: ein Druck wirkt wie der Trigger-Button im Dashboard
const gpio = new GpioButton();
gpio.on('press', () => {
  const result = triggerNext();
  if (result.ok) {
    console.log('GPIO: Taster gedrückt – nächstes Video getriggert.');
  } else {
    console.warn(`GPIO: Taster gedrückt, aber kein Trigger möglich: ${result.error}`);
  }
});

function applyGpioSettings() {
  const pin = settings.getGpioPin();
  if (pin === null) gpio.disable();
  else gpio.configure(pin, settings.getGpioDebounceMs());
}

function savePlaylists() {
  storage.savePlaylists(playlists);
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
    remaining_videos: total - next,
  };
}

function serializePlaylists() {
  const progress = getActiveProgress();
  return [...playlists.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map((playlist) => ({
      name: playlist.name,
      loop_video: playlist.loop_video,
      videos: playlist.videos,
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
  broadcastState();
  return { ok: true, warning };
}

/** @returns {{ok: boolean, error?: string}} */
function triggerNext() {
  if (!activePlaylist) return { ok: false, error: 'Keine aktive Playlist.' };
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
    return { ok: false, error: message };
  }
  broadcastState();
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
  broadcastState();
  return true;
}

function duplicatePlaylist(name, requestedName) {
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
    if (playlists.has(candidate)) throw new Error('Eine Playlist mit diesem Namen existiert bereits.');
  } else {
    const base = `${original.name} Kopie`;
    candidate = base;
    let suffix = 2;
    while (playlists.has(candidate)) candidate = `${base} ${suffix++}`;
  }
  const copy = { name: candidate, loop_video: original.loop_video, videos: [...original.videos] };
  playlists.set(candidate, copy);
  savePlaylists();
  broadcastState();
  return copy;
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

// Server-Sent Events ------------------------------------------------------------

const sseClients = new Set();

function stateSnapshot() {
  return {
    status: player.getStatus(),
    active_playlist: activePlaylist,
    active_progress: getActiveProgress(),
  };
}

function broadcastState() {
  const data = `data: ${JSON.stringify(stateSnapshot())}\n\n`;
  for (const client of sseClients) client.write(data);
}

player.on('status', () => broadcastState());

// Express ------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

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

// Verfügbare Audio-Geräte (von mpv erfragt)
app.get('/api/audio-devices', async (req, res) => {
  const devices = await player.getAudioDeviceList();
  res.json({ devices, current: settings.getAudioOutput() });
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
  if (playlists.has(name)) return res.status(409).json({ status: 'error', message: 'Eine Playlist mit diesem Namen existiert bereits.' });
  const invalid = validatePlaylistVideos(loopVideo, videos);
  if (invalid) return res.status(400).json({ status: 'error', message: invalid });
  const playlist = { name, loop_video: loopVideo, videos };
  playlists.set(name, playlist);
  savePlaylists();
  broadcastState();
  res.status(201).json({ status: 'ok', playlist });
});

app.put('/api/playlists/:name', (req, res) => {
  const playlist = playlists.get(req.params.name);
  if (!playlist) return res.status(404).json({ status: 'error', message: 'Playlist wurde nicht gefunden.' });
  const loopVideo = req.body?.loop_video || null;
  const videos = Array.isArray(req.body?.videos) ? req.body.videos.map(String) : [];
  const invalid = validatePlaylistVideos(loopVideo, videos);
  if (invalid) return res.status(400).json({ status: 'error', message: invalid });
  playlist.loop_video = loopVideo;
  playlist.videos = videos;
  savePlaylists();
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
  const playlistName =
    req.method === 'GET' ? req.query.playlist : req.body?.playlist ?? req.query.playlist;
  if (playlistName) {
    const started = startPlaylist(String(playlistName));
    if (!started.ok) return res.status(404).json({ status: 'error', message: 'Playlist nicht gefunden' });
  }
  const result = triggerNext();
  if (!result.ok) return res.status(400).json({ status: 'error', message: result.error ?? 'Kein Video verfügbar' });
  res.json({ status: 'ok' });
});

// Eingehender Webhook: Playlist starten und sofort erstes Video triggern
app.post('/webhook/:name', (req, res) => {
  const started = startPlaylist(req.params.name);
  if (!started.ok) return res.status(404).json({ status: 'error', message: 'Playlist nicht gefunden' });
  const result = triggerNext();
  if (!result.ok) return res.status(400).json({ status: 'error', message: result.error ?? 'Kein Video verfügbar' });
  res.json({ status: 'ok' });
});

app.get('/api/videos', (req, res) => {
  res.json({ videos: library.list(), tree: library.tree() });
});

// Videodateien streamen (mit Range-Support für die Browser-Vorschau)
app.get('/videos/*path', (req, res) => {
  const relative = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
  res.sendFile(relative, { root: settings.getVideoDirectory(), dotfiles: 'deny' }, (err) => {
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

  const previousAudio = settings.getAudioOutput();
  const previousDrmMode = settings.getDrmMode();
  if (typeof body.drm_mode === 'string') {
    const value = body.drm_mode.trim();
    if (value !== '' && !/^\d{3,4}x\d{3,4}(@\d{1,3})?$/.test(value)) {
      return res.status(400).json({ status: 'error', message: 'Ausgabe-Auflösung bitte als BREITExHÖHE angeben, z. B. 1920x1080.' });
    }
    settings.setDrmMode(value);
  }
  if (typeof body.audio_output === 'string') settings.setAudioOutput(body.audio_output);
  if (typeof body.trigger_start_webhook_url === 'string') settings.setTriggerStartWebhook(body.trigger_start_webhook_url);
  if (typeof body.trigger_end_webhook_url === 'string') settings.setTriggerEndWebhook(body.trigger_end_webhook_url);

  if (typeof body.auto_start_playlist === 'string') {
    const name = body.auto_start_playlist.trim();
    if (name && !playlists.has(name)) {
      return res.status(400).json({ status: 'error', message: 'Die ausgewählte Playlist wurde nicht gefunden.' });
    }
    settings.setAutoStartPlaylist(name);
  }

  if (typeof body.video_directory === 'string') {
    let updated;
    try {
      updated = settings.setVideoDirectory(body.video_directory);
    } catch (err) {
      return res.status(400).json({ status: 'error', message: err.message });
    }
    if (updated !== player.videoDir) {
      player.setVideoDirectory(updated);
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
  }

  if (settings.getAudioOutput() !== previousAudio) {
    player.restart();
    warnings.push('Audio-Gerät geändert – der Player wird neu gestartet.');
  } else if (settings.getDrmMode() !== previousDrmMode) {
    player.restart();
    warnings.push('Ausgabe-Auflösung geändert – der Player wird neu gestartet.');
  }

  if (typeof body.gpio_pin === 'string') {
    const value = body.gpio_pin.trim();
    if (value !== '') {
      const pin = Number(value);
      if (!Number.isInteger(pin) || pin < 0 || pin > 27) {
        return res.status(400).json({ status: 'error', message: 'GPIO-Pin muss eine BCM-Nummer zwischen 0 und 27 sein.' });
      }
    }
    settings.setGpioPin(value);
  }
  if (body.gpio_debounce_ms !== undefined) {
    const debounce = Number(body.gpio_debounce_ms);
    if (!Number.isFinite(debounce) || debounce < 50 || debounce > 5000) {
      return res.status(400).json({ status: 'error', message: 'Entprellzeit muss zwischen 50 und 5000 ms liegen.' });
    }
    settings.setGpioDebounceMs(debounce);
  }
  applyGpioSettings();

  broadcastState();
  res.json({ status: 'ok', settings: settings.toJSON(), warnings, gpio: gpio.getStatus() });
});

app.post('/api/folders', (req, res) => {
  const folderPath = String(req.body?.path ?? '').trim();
  if (!folderPath) return res.status(400).json({ status: 'error', message: 'Bitte einen Ordnernamen angeben.' });
  const base = settings.getVideoDirectory();
  const target = path.resolve(base, folderPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
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

function sanitizeFilename(original) {
  // multer liefert Dateinamen als latin1 – nach UTF-8 zurückwandeln (Umlaute!)
  let name = original;
  try {
    const decoded = Buffer.from(original, 'latin1').toString('utf8');
    if (!decoded.includes('�')) name = decoded;
  } catch {
    /* Original behalten */
  }
  name = path.basename(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (name.startsWith('.')) name = `_${name.slice(1)}`;
  return name;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const base = settings.getVideoDirectory();
        const sub = String(req.body?.subdirectory ?? '').trim();
        const target = sub ? path.resolve(base, sub) : base;
        if (target !== base && !target.startsWith(base + path.sep)) {
          cb(new Error('Der Zielordner muss innerhalb des Videoverzeichnisses liegen.'));
          return;
        }
        fs.mkdirSync(target, { recursive: true });
        cb(null, target);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const name = sanitizeFilename(file.originalname);
      if (!name || !isVideoFile(name)) {
        cb(new Error(`Ungültige Videodatei: ${file.originalname}`));
        return;
      }
      cb(null, name);
    },
  }),
  limits: { fileSize: 8 * 1024 ** 3, files: 50 },
});

app.post('/api/upload', (req, res) => {
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

applyGpioSettings();

const autoStart = settings.getAutoStartPlaylist();
if (autoStart) {
  if (!startPlaylist(autoStart).ok) {
    console.warn(`Auto-Start-Playlist "${autoStart}" wurde nicht gefunden.`);
    settings.setAutoStartPlaylist(null);
  } else {
    console.log(`Auto-Start: Playlist "${autoStart}" aktiviert.`);
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`BeamPi läuft auf http://0.0.0.0:${PORT}`);
  console.log(`Videoverzeichnis: ${settings.getVideoDirectory()}`);
});

function shutdown() {
  gpio.stop();
  player.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
