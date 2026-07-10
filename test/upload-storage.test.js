import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createUploadStorage, sanitizeFilename } from '../src/upload-storage.js';

function store(storage, req, file) {
  return new Promise((resolve, reject) => {
    storage._handleFile(req, file, (err, info) => err ? reject(err) : resolve(info));
  });
}

test('Upload-Storage vergibt Namen exklusiv und entfernt abgebrochene Dateien', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beampi-upload-'));
  const videos = path.join(root, 'videos');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(videos);
  fs.mkdirSync(outside);
  const storage = createUploadStorage(() => videos);

  try {
    assert.equal(sanitizeFilename('../schön?.mp4'), 'schön_.mp4');
    fs.writeFileSync(path.join(videos, 'clip.mp4'), 'existing');
    const saved = await store(storage, { query: {}, body: {} }, {
      originalname: 'clip.mp4',
      stream: Readable.from(['video-data']),
    });
    assert.equal(saved.filename, 'clip (2).mp4');
    assert.equal(fs.readFileSync(saved.path, 'utf8'), 'video-data');

    const broken = new Readable({
      read() {
        this.push('partial');
        this.destroy(new Error('Upload abgebrochen'));
      },
    });
    await assert.rejects(store(storage, { query: {}, body: {} }, {
      originalname: 'broken.mp4', stream: broken,
    }), /Upload abgebrochen/);
    assert.equal(fs.existsSync(path.join(videos, 'broken.mp4')), false);

    fs.symlinkSync(outside, path.join(videos, 'escape'));
    await assert.rejects(store(storage, { query: { subdirectory: 'escape' }, body: {} }, {
      originalname: 'outside.mp4', stream: Readable.from(['nope']),
    }), /innerhalb des Videoverzeichnisses/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
