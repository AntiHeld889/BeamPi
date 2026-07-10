import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MediaMeta } from '../src/media.js';

async function waitFor(read, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(read(), expected);
}

test('Mediencache trennt Video-Wurzeln und merkt fehlgeschlagene Probes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beampi-media-'));
  const bin = path.join(root, 'bin');
  const data = path.join(root, 'data');
  const firstDir = path.join(root, 'first');
  const secondDir = path.join(root, 'second');
  const failedLog = path.join(root, 'failed.log');
  for (const dir of [bin, data, firstDir, secondDir]) fs.mkdirSync(dir, { recursive: true });

  const probe = path.join(bin, 'ffprobe');
  fs.writeFileSync(probe, `#!/bin/sh
for arg in "$@"; do file="$arg"; done
if grep -q 'FIRST' "$file"; then echo 10; exit 0; fi
if grep -q 'SECOND' "$file"; then echo 20; exit 0; fi
printf 'failed\\n' >> '${failedLog.replaceAll("'", "'\\''")}'
exit 1
`);
  fs.chmodSync(probe, 0o755);

  const rel = 'same.mp4';
  const firstFile = path.join(firstDir, rel);
  const secondFile = path.join(secondDir, rel);
  fs.writeFileSync(firstFile, 'FIRST!');
  fs.writeFileSync(secondFile, 'SECOND');
  const timestamp = new Date('2025-01-01T00:00:00Z');
  fs.utimesSync(firstFile, timestamp, timestamp);
  fs.utimesSync(secondFile, timestamp, timestamp);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  let currentDir = firstDir;
  try {
    const media = new MediaMeta(data, () => currentDir);
    const firstStat = fs.statSync(firstFile);
    const first = [{ path: rel, size: firstStat.size, mtimeMs: firstStat.mtimeMs }];
    media.ensureDurations(first);
    await waitFor(() => media.durationFor(rel, firstStat.size, firstStat.mtimeMs), 10);

    currentDir = secondDir;
    const secondStat = fs.statSync(secondFile);
    const second = [{ path: rel, size: secondStat.size, mtimeMs: secondStat.mtimeMs }];
    assert.equal(media.durationFor(rel, secondStat.size, secondStat.mtimeMs), null);
    media.ensureDurations(second);
    await waitFor(() => media.durationFor(rel, secondStat.size, secondStat.mtimeMs), 20);

    const failedRel = 'failed.mp4';
    const failedFile = path.join(secondDir, failedRel);
    fs.writeFileSync(failedFile, 'FAIL!!');
    const failedStat = fs.statSync(failedFile);
    const failed = [{ path: failedRel, size: failedStat.size, mtimeMs: failedStat.mtimeMs }];
    media.ensureDurations(failed);
    await waitFor(() => fs.existsSync(failedLog), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    media.ensureDurations(failed);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.readFileSync(failedLog, 'utf8').trim().split('\n').length, 1);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
