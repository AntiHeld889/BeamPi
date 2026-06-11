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
  drm_mode: '',
};

export class SettingsManager {
  constructor(storage) {
    this.storage = storage;
    const stored = storage.loadSettings();
    this.settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof stored[key] === 'string') this.settings[key] = stored[key];
    }
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

  /** @param {string} mode z. B. '1920x1080' oder '' für automatisch */
  setDrmMode(mode) {
    this.settings.drm_mode = (mode || '').trim();
    this.save();
  }

  getDrmMode() {
    const value = this.settings.drm_mode.trim();
    return /^\d{3,4}x\d{3,4}(@\d{1,3})?$/.test(value) ? value : '';
  }
}
