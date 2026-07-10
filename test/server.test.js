import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Auth } from '../src/auth.js';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server wurde mit Code ${child.exitCode} beendet.`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok) return;
    } catch {
      // Start läuft noch.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server wurde nicht rechtzeitig erreichbar.');
}

test('Server-APIs: strikte Booleans, sichere Pfade, Upload und Live-Passwortwechsel', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beampi-server-'));
  const dataDir = path.join(root, 'data');
  const videoDir = path.join(root, 'videos');
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.mp4'), 'secret');
  fs.symlinkSync(outsideDir, path.join(videoDir, 'escape'));

  let port;
  try {
    port = await freePort();
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      fs.rmSync(root, { recursive: true, force: true });
      t.skip('Die Ausführungsumgebung erlaubt keinen lokalen HTTP-Listener.');
      return;
    }
    throw err;
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BEAMPI_DATA_DIR: dataDir,
      BEAMPI_VIDEO_DIR: videoDir,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    await waitForServer(baseUrl, child);
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'beampi' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    await fetch(`${baseUrl}/api/volume`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ muted: true }),
    });
    const unmute = await fetch(`${baseUrl}/api/volume`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'muted=false',
    });
    assert.equal((await unmute.json()).muted, false);

    const invalidBoolean = await fetch(`${baseUrl}/api/auto-trigger`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    assert.equal(invalidBoolean.status, 400);

    const escaped = await fetch(`${baseUrl}/videos/escape/secret.mp4`, { headers: { cookie } });
    assert.equal(escaped.status, 400);

    const form = new FormData();
    form.append('video_files', new Blob(['video-data'], { type: 'video/mp4' }), 'clip.mp4');
    const upload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { cookie }, body: form,
    });
    assert.equal(upload.status, 200);
    assert.deepEqual((await upload.json()).saved, ['clip.mp4']);
    assert.equal(fs.readFileSync(path.join(videoDir, 'clip.mp4'), 'utf8'), 'video-data');

    const cliAuth = new Auth(dataDir);
    cliAuth.setPassword('changed123');
    const expiredSession = await fetch(`${baseUrl}/api/state`, { headers: { cookie } });
    assert.equal(expiredSession.status, 401);
    const newLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'changed123' }),
    });
    assert.equal(newLogin.status, 200);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
