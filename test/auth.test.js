import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Auth } from '../src/auth.js';

test('laufende Auth-Instanz übernimmt externe Passwort- und Sessionänderungen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beampi-auth-'));
  try {
    const serverAuth = new Auth(dir);
    const oldSession = serverAuth.createSession();
    const cliAuth = new Auth(dir);

    cliAuth.setPassword('changed123');

    assert.equal(serverAuth.verifyCredentials('admin', 'beampi'), false);
    assert.equal(serverAuth.verifyCredentials('admin', 'changed123'), true);
    assert.equal(serverAuth.validateSession(oldSession), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
