import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SettingsManager } from '../src/settings.js';

test('gebündelte Einstellungsänderungen schreiben nur einmal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beampi-settings-'));
  const writes = [];
  const storage = {
    loadSettings: () => ({}),
    saveSettings: (settings) => writes.push({ ...settings }),
  };
  try {
    const settings = new SettingsManager(storage);
    settings.batchUpdate(() => {
      settings.setVideoDirectory(dir);
      settings.setAudioOutput('alsa/test');
      settings.setTriggerStartWebhook('https://example.test/start');
      settings.setTriggerEndWebhook('https://example.test/end');
      settings.setAutoStartPlaylist('Show');
      settings.setGpioDebounceMs(300);
    });

    assert.equal(writes.length, 1);
    assert.equal(writes[0].audio_output, 'alsa/test');
    assert.equal(writes[0].video_directory, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
