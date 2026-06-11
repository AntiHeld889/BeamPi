import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SOCKET_PATH = path.join(os.tmpdir(), 'beampi-mpv.sock');
const CONNECT_TIMEOUT_MS = 6000;
const RESTART_DELAY_MS = 2000;

export class VideoNotFoundError extends Error {}
export class InvalidVideoPathError extends Error {}

/**
 * Steuert mpv im Hintergrund über dessen JSON-IPC-Socket.
 *
 * Zustandsmodell wie das Original (BeamerPi):
 *  - loop:    ein Loop-Video läuft endlos (loop-file=inf)
 *  - trigger: ein einzelnes Video läuft genau einmal; danach zurück zum Loop
 *  - idle:    nichts spielt (kein Loop gesetzt)
 * Trigger, die während eines laufenden Triggers ankommen, warten in der Queue.
 */
export class Player extends EventEmitter {
  #queue = [];
  #loopVideo = null; // absoluter Pfad
  #playingTrigger = false;
  #currentVideo = null; // absoluter Pfad
  #currentIsLoop = false;
  #proc = null;
  #sock = null;
  #buffer = '';
  #connected = false;
  #stopped = false;
  #starting = false;
  #restartTimer = null;
  #connectTimer = null;
  #requestId = 0;
  #pending = new Map();

  constructor({ videoDir, getAudioDevice, getStartWebhookUrl, getEndWebhookUrl, getDrmMode }) {
    super();
    this.videoDir = path.resolve(videoDir);
    fs.mkdirSync(this.videoDir, { recursive: true });
    this.getAudioDevice = getAudioDevice;
    this.getDrmMode = getDrmMode ?? (() => '');
    this.getStartWebhookUrl = getStartWebhookUrl;
    this.getEndWebhookUrl = getEndWebhookUrl;
    this.#startMpv();
  }

  // Öffentliche API ----------------------------------------------------------

  setVideoDirectory(videoDir) {
    this.videoDir = path.resolve(videoDir);
    fs.mkdirSync(this.videoDir, { recursive: true });
    this.#queue = [];
    this.#loopVideo = null;
    this.#syncPlayback();
    this.#emitStatus();
  }

  /** @param {string|null} relativePath */
  setLoopVideo(relativePath) {
    this.#loopVideo = relativePath ? this.#resolveVideo(relativePath) : null;
    this.#syncPlayback();
    this.#emitStatus();
  }

  /** @param {string} relativePath */
  enqueue(relativePath) {
    const absolute = this.#resolveVideo(relativePath);
    this.#queue.push(absolute);
    this.#pump();
  }

  /** mpv neu starten (z. B. nach Wechsel des Audio-Geräts). */
  restart() {
    if (this.#proc && this.#proc.exitCode === null) {
      this.#proc.kill('SIGTERM');
    } else {
      this.#startMpv();
    }
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#restartTimer);
    clearInterval(this.#connectTimer);
    this.#sock?.destroy();
    if (this.#proc && this.#proc.exitCode === null) this.#proc.kill('SIGTERM');
  }

  /**
   * Aktuelle Abspielposition für die Live-Vorschau im Browser.
   * @returns {Promise<{video: string, mode: string, position: number|null, duration: number|null, paused: boolean}|null>}
   */
  async getPlaybackInfo() {
    if (!this.#connected || !this.#currentVideo) return null;
    const video = this.#relative(this.#currentVideo);
    const [position, duration, paused] = await Promise.all([
      this.#request(['get_property', 'playback-time']),
      this.#request(['get_property', 'duration']),
      this.#request(['get_property', 'pause']),
    ]);
    return {
      video,
      mode: this.getStatus().mode,
      position: typeof position === 'number' ? position : null,
      duration: typeof duration === 'number' ? duration : null,
      paused: paused === true,
    };
  }

  getStatus() {
    let mode = 'idle';
    if (this.#playingTrigger) mode = 'trigger';
    else if (this.#currentIsLoop && this.#loopVideo) mode = 'loop';
    return {
      mode,
      running: this.#connected,
      current_video: this.#relative(this.#currentVideo),
      loop_video: this.#relative(this.#loopVideo),
      queued: this.#queue.length,
    };
  }

  // Pfad-Handling ------------------------------------------------------------

  #resolveVideo(relativePath) {
    const base = path.resolve(this.videoDir);
    const absolute = path.resolve(base, relativePath);
    if (absolute !== base && !absolute.startsWith(base + path.sep)) {
      throw new InvalidVideoPathError('Der Videopfad muss innerhalb des Videoverzeichnisses liegen.');
    }
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      throw new VideoNotFoundError(`Video ${relativePath} wurde nicht gefunden.`);
    }
    if (!stat.isFile()) {
      throw new VideoNotFoundError(`Video ${relativePath} wurde nicht gefunden.`);
    }
    return absolute;
  }

  #relative(absolute) {
    if (!absolute) return null;
    const rel = path.relative(this.videoDir, absolute);
    if (rel.startsWith('..')) return absolute;
    return rel.split(path.sep).join('/');
  }

  // Wiedergabe-Logik -----------------------------------------------------------

  /** Startet den nächsten Trigger aus der Queue, falls gerade keiner läuft. */
  #pump() {
    if (!this.#connected || this.#playingTrigger) return;
    const next = this.#queue.shift();
    if (next) {
      this.#playingTrigger = true;
      this.#currentVideo = next;
      this.#currentIsLoop = false;
      this.#loadFile(next, false);
      this.#sendWebhook('start', next);
      this.#emitStatus();
    } else {
      this.#syncPlayback();
    }
  }

  /** Stellt sicher, dass außerhalb eines Triggers der Loop (oder Stille) läuft. */
  #syncPlayback() {
    if (!this.#connected || this.#playingTrigger) return;
    if (this.#queue.length > 0) {
      this.#pump();
      return;
    }
    if (!this.#loopVideo) {
      if (this.#currentVideo) this.#command(['stop']);
      this.#currentVideo = null;
      this.#currentIsLoop = false;
      this.#emitStatus();
      return;
    }
    if (this.#currentIsLoop && this.#currentVideo === this.#loopVideo) return;
    this.#currentVideo = this.#loopVideo;
    this.#currentIsLoop = true;
    this.#loadFile(this.#loopVideo, true);
    this.#emitStatus();
  }

  #loadFile(absolute, loop) {
    this.#command(['loadfile', absolute, 'replace']);
    this.#command(['set', 'loop-file', loop ? 'inf' : 'no']);
  }

  // mpv-Prozess + IPC ----------------------------------------------------------

  #startMpv() {
    if (this.#stopped || this.#starting) return;
    this.#starting = true;

    try {
      fs.rmSync(SOCKET_PATH, { force: true });
    } catch {
      /* egal */
    }

    // Wichtig: DISPLAY hier NICHT künstlich setzen. Ein gesetztes DISPLAY ohne
    // laufenden X-Server schickt mpv in einen fehlerhaften Fallback-Pfad.
    const env = { ...process.env };

    const args = [
      '--idle=yes',
      '--force-window=immediate',
      '--fs',
      '--no-osc',
      '--no-osd-bar',
      '--keep-open=no',
      `--input-ipc-server=${SOCKET_PATH}`,
      '--really-quiet',
      '--no-terminal',
      // Hardware-Dekodierung explizit: v4l2m2m (h264 u. a.) und drm/rpivid (hevc).
      // Die auto-Modi von mpv wählen die Pi-Decoder NICHT von selbst aus;
      // bei Fehlschlag fällt mpv automatisch auf Software zurück.
      '--hwdec=v4l2m2m-copy,drm-copy',
      // Günstige Skalierer – wichtig, wenn auf 4K hochskaliert wird (Pi-4-GPU)
      '--profile=fast',
      '--framedrop=vo',
    ];
    const audioDevice = (this.getAudioDevice() || '').trim();
    if (audioDevice && audioDevice !== 'auto') {
      args.push(`--audio-device=${audioDevice}`);
    }

    // Ausgabe-Auflösung bei Direktausgabe ohne Desktop (DRM/KMS). Entlastet
    // z. B. den Pi 4 an 4K-Displays massiv; unter Wayland/X11 ohne Wirkung.
    const drmMode = this.getDrmMode();
    if (drmMode) args.push(`--drm-mode=${drmMode}`);

    // Läuft kein Compositor (Wayland-Socket fehlt) und kein X (kein DISPLAY),
    // den DRM-Kontext erzwingen. Ohne das fällt mpv auf vo=sdl zurück und
    // rendert UNSICHTBAR ins Leere, während der Status "spielt" meldet.
    const waylandSocket = env.WAYLAND_DISPLAY
      ? env.WAYLAND_DISPLAY.startsWith('/')
        ? env.WAYLAND_DISPLAY
        : path.join(env.XDG_RUNTIME_DIR ?? '', env.WAYLAND_DISPLAY)
      : null;
    const haveWayland = waylandSocket ? fs.existsSync(waylandSocket) : false;
    if (!haveWayland && !env.DISPLAY) {
      args.push('--vo=gpu', '--gpu-context=drm');
    }

    let proc;
    try {
      proc = spawn('mpv', args, { env, stdio: 'ignore' });
    } catch (err) {
      console.error(`mpv konnte nicht gestartet werden: ${err.message}`);
      this.#starting = false;
      this.#scheduleRestart();
      return;
    }

    proc.on('error', (err) => {
      console.error(`mpv-Fehler: ${err.message}`);
      this.#starting = false;
      this.#handleMpvGone();
    });
    proc.on('exit', () => {
      if (this.#proc === proc) this.#handleMpvGone();
    });
    this.#proc = proc;

    // Auf den IPC-Socket warten und verbinden.
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    clearInterval(this.#connectTimer);
    this.#connectTimer = setInterval(() => {
      if (this.#stopped || this.#proc !== proc || proc.exitCode !== null) {
        clearInterval(this.#connectTimer);
        this.#starting = false;
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(this.#connectTimer);
        this.#starting = false;
        console.error('mpv-IPC-Verbindung fehlgeschlagen.');
        proc.kill('SIGTERM');
        return;
      }
      if (!fs.existsSync(SOCKET_PATH)) return;

      clearInterval(this.#connectTimer);
      const sock = net.createConnection(SOCKET_PATH);
      sock.setEncoding('utf8');
      sock.on('connect', () => {
        this.#sock = sock;
        this.#buffer = '';
        this.#connected = true;
        this.#starting = false;
        this.#syncPlayback();
        this.#emitStatus();
      });
      sock.on('data', (chunk) => this.#onData(chunk));
      sock.on('error', () => {});
      sock.on('close', () => {
        if (this.#sock === sock) this.#handleMpvGone();
      });
    }, 100);
  }

  #handleMpvGone() {
    const hadProcess = this.#proc !== null || this.#sock !== null;
    clearInterval(this.#connectTimer);
    this.#sock?.destroy();
    this.#sock = null;
    if (this.#proc && this.#proc.exitCode === null) this.#proc.kill('SIGKILL');
    this.#proc = null;
    this.#connected = false;
    this.#starting = false;
    this.#playingTrigger = false;
    this.#currentVideo = null;
    this.#currentIsLoop = false;
    for (const resolve of this.#pending.values()) resolve(null);
    this.#pending.clear();
    if (hadProcess && !this.#stopped) {
      this.#emitStatus();
      this.#scheduleRestart();
    }
  }

  #scheduleRestart() {
    if (this.#stopped) return;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => this.#startMpv(), RESTART_DELAY_MS);
  }

  #command(command) {
    if (!this.#sock || !this.#connected) return;
    try {
      this.#sock.write(`${JSON.stringify({ command })}\n`);
    } catch {
      this.#handleMpvGone();
    }
  }

  /** Befehl mit Antwort (request_id-Korrelation). Liefert null bei Fehler/Timeout. */
  #request(command, timeoutMs = 1000) {
    if (!this.#sock || !this.#connected) return Promise.resolve(null);
    const id = ++this.#requestId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.#pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      try {
        this.#sock.write(`${JSON.stringify({ command, request_id: id })}\n`);
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(null);
        this.#handleMpvGone();
      }
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.request_id !== undefined && this.#pending.has(event.request_id)) {
        const resolve = this.#pending.get(event.request_id);
        this.#pending.delete(event.request_id);
        resolve(event.error === 'success' ? event.data : null);
        continue;
      }
      this.#onEvent(event);
    }
  }

  #onEvent(event) {
    if (event.event !== 'end-file') return;
    // Nur reguläres Abspielende zählt; "replace"/"stop"/"error" lösen keinen
    // Loop-Rückfall mit Webhook aus (wie im Original).
    const reason = event.reason;
    const isEof = reason === undefined || reason === null || reason === 'eof' || reason === 0;
    if (!isEof) return;

    const wasTrigger = this.#playingTrigger;
    const finished = this.#currentVideo;
    this.#playingTrigger = false;
    this.#currentVideo = null;
    this.#currentIsLoop = false;
    if (wasTrigger && finished) this.#sendWebhook('end', finished);
    this.#pump();
    this.#emitStatus();
  }

  #emitStatus() {
    this.emit('status', this.getStatus());
  }

  // Ausgehende Webhooks ----------------------------------------------------------

  async #sendWebhook(eventName, absolutePath) {
    const url =
      eventName === 'start' ? this.getStartWebhookUrl() : this.getEndWebhookUrl();
    if (!url || !url.trim()) return;

    const payload = {
      event: eventName,
      video: this.#relative(absolutePath),
      timestamp: Date.now() / 1000,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 405 || response.status === 501) {
        await this.#sendWebhookGet(url, payload);
      }
    } catch (err) {
      console.warn(`Webhook ${url} fehlgeschlagen: ${err.message}`);
    }
  }

  async #sendWebhookGet(url, payload) {
    try {
      const target = new URL(url);
      for (const [key, value] of Object.entries(payload)) {
        target.searchParams.append(key, String(value));
      }
      await fetch(target, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      console.warn(`Webhook (GET) ${url} fehlgeschlagen: ${err.message}`);
    }
  }
}
