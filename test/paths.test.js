import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveContainedPath } from '../src/paths.js';

test('Pfadauflösung blockiert Traversal und Symlink-Ausbrüche', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beampi-paths-'));
  const base = path.join(root, 'videos');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(base);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(base, 'escape'));

  try {
    assert.equal(resolveContainedPath(base, '../outside/file.mp4'), null);
    assert.equal(resolveContainedPath(base, 'escape/file.mp4'), null);
    assert.equal(resolveContainedPath(base, 'new/folder/file.mp4'), path.join(base, 'new/folder/file.mp4'));
    assert.equal(resolveContainedPath(base, '.', { allowBase: false }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
