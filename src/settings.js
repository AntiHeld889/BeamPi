import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_VIDEO_DIRECTORY =
  process.env.BEAMPI_VIDEO_DIR || '/opt/beampi/videos';

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const DEFAULTS = {
  audio_output: 'auto',
  trigger_start_webhook_url: '',
  trigger_end_webhook_url: '',
  video_directory: DEFAULT_VIDEO_DIRECTORY,
  auto_start_playlist: '',
  gpio_pin: '',
  gpio_debounce_ms: '250',
  volume: '100',
  muted: '0',
  auto_trigger_enabled: '0',
  auto_trigger_interval_s: '300',
};

export class SettingsManager {
  // Laufzeit-Overrides für den USB-Stick-Modus. Sie haben Vorrang vor den
  // gespeicherten Werten, werden aber NICHT auf die Platte geschrieben –
  // Stick abziehen + Neustart stellt den Normalbetrieb wieder her.
  #overrides = {};

  constructor(storage) {
    this.storage = storage;
    const stored = storage.loadSettings();
    this.settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof stored[key] === 'string') this.settings[key] = stored[key];
    }
  }

  /**
   * USB-Stick-Modus aktivieren: Videoverzeichnis + Auto-Trigger zur Laufzeit
   * überschreiben (nicht persistent).
   */
  applyUsbOverrides({ videoDirectory, autoTriggerEnabled, autoTriggerIntervalS }) {
    this.#overrides = {
      video_directory: path.resolve(videoDirectory),
      auto_trigger_enabled: autoTriggerEnabled ? '1' : '0',
      auto_trigger_interval_s: String(autoTriggerIntervalS),
    };
  }

  hasUsbOverrides() {
    return Object.keys(this.#overrides).length > 0;
  }

  save() {
    this.storage.saveSettings(this.settings);
  }

  toJSON() {
    return { ...this.settings };
  }

  setAudioOutput(value) {
    this.settings.audio_output = (value || 'auto').trim() || 'auto';
    this.save();
  }

  getAudioOutput() {
    return this.settings.audio_output;
  }

  setTriggerStartWebhook(url) {
    this.settings.trigger_start_webhook_url = (url || '').trim();
    this.save();
  }

  getTriggerStartWebhook() {
    return this.settings.trigger_start_webhook_url;
  }

  setTriggerEndWebhook(url) {
    this.settings.trigger_end_webhook_url = (url || '').trim();
    this.save();
  }

  getTriggerEndWebhook() {
    return this.settings.trigger_end_webhook_url;
  }

  /** @returns {string} absoluter Pfad des Videoverzeichnisses */
  setVideoDirectory(directory) {
    let value = (directory || '').trim();
    if (!value) value = DEFAULT_VIDEO_DIRECTORY;
    const resolved = path.resolve(expandHome(value));
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (err) {
      throw new Error(`Ordner konnte nicht erstellt werden: ${err.message}`);
    }
    this.settings.video_directory = resolved;
    this.save();
    return resolved;
  }

  getVideoDirectory() {
    // Im USB-Modus direkt den (read-only) Stick-Pfad liefern – kein mkdir,
    // der Ordner existiert bereits und die Karte ist schreibgeschützt.
    if (this.#overrides.video_directory) return this.#overrides.video_directory;
    const resolved = path.resolve(expandHome(this.settings.video_directory));
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  setAutoStartPlaylist(name) {
    this.settings.auto_start_playlist = (name || '').trim();
    this.save();
  }

  getAutoStartPlaylist() {
    return this.settings.auto_start_playlist;
  }

  /** @param {string} pin BCM-Pin als String, '' = deaktiviert */
  setGpioPin(pin) {
    this.settings.gpio_pin = (pin || '').trim();
    this.save();
  }

  /** @returns {number|null} BCM-Pin oder null wenn deaktiviert */
  getGpioPin() {
    const value = this.settings.gpio_pin.trim();
    if (value === '') return null;
    const pin = Number(value);
    return Number.isInteger(pin) && pin >= 0 && pin <= 27 ? pin : null;
  }

  setGpioDebounceMs(value) {
    this.settings.gpio_debounce_ms = String(value);
    this.save();
  }

  getGpioDebounceMs() {
    const value = Number(this.settings.gpio_debounce_ms);
    return Number.isFinite(value) && value >= 50 && value <= 5000 ? value : 250;
  }

  /** @param {number} value 0–100 */
  setVolume(value) {
    const volume = Math.round(Number(value));
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) return;
    this.settings.volume = String(volume);
    this.save();
  }

  getVolume() {
    const value = Number(this.settings.volume);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : 100;
  }

  setMuted(muted) {
    this.settings.muted = muted ? '1' : '0';
    this.save();
  }

  getMuted() {
    return this.settings.muted === '1';
  }

  setAutoTriggerEnabled(enabled) {
    this.settings.auto_trigger_enabled = enabled ? '1' : '0';
    this.save();
  }

  getAutoTriggerEnabled() {
    if (this.#overrides.auto_trigger_enabled !== undefined) {
      return this.#overrides.auto_trigger_enabled === '1';
    }
    return this.settings.auto_trigger_enabled === '1';
  }

  /** @param {number} seconds 1 s bis 60 min 60 s (3660 s) */
  setAutoTriggerIntervalS(seconds) {
    const value = Math.round(Number(seconds));
    if (!Number.isFinite(value) || value < 1 || value > 3660) return;
    this.settings.auto_trigger_interval_s = String(value);
    this.save();
  }

  getAutoTriggerIntervalS() {
    const source =
      this.#overrides.auto_trigger_interval_s ?? this.settings.auto_trigger_interval_s;
    const value = Number(source);
    return Number.isInteger(value) && value >= 1 && value <= 3660 ? value : 300;
  }
}
