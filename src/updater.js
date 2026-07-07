// Selbst-Update: vergleicht die installierte Version mit dem aktuellen Stand
// auf GitHub und kann den Pi per Knopfdruck auf die neueste Version ziehen.
//
// Der Pi wird per rsync deployt (kein git-Clone unter /opt/beampi), darum holt
// das Update den öffentlichen Repo-Stand als Tarball – ohne Zugangsdaten, ohne
// git. Das eigentliche Ersetzen/Neustarten erledigt deploy/self-update.sh.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const REPO = 'AntiHeld889/BeamPi';
const BRANCH = 'main';
const RAW_PKG_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`;
const TARBALL_URL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`;

/** Version aus einer package.json lesen (oder '0.0.0', falls nicht lesbar). */
export function readVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0').trim();
  } catch {
    return '0.0.0';
  }
}

/**
 * Semver-Vergleich (nur die numerischen x.y.z-Teile). Vorab-Suffixe wie
 * "-beta" werden ignoriert – für unsere reinen Patch-Versionen genügt das.
 * @returns {number} >0 wenn a neuer als b, <0 wenn älter, 0 bei gleich
 */
export function compareVersions(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Neueste Version aus der package.json auf GitHub lesen (mit Timeout). */
export async function fetchLatestVersion(timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(RAW_PKG_URL, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`GitHub antwortete mit ${res.status}`);
    const pkg = await res.json();
    const version = String(pkg.version || '').trim();
    if (!version) throw new Error('Keine Versionsangabe gefunden.');
    return version;
  } finally {
    clearTimeout(timer);
  }
}

let updating = false;

/** Läuft gerade ein Update? (verhindert parallele Starts) */
export function isUpdating() {
  return updating;
}

/**
 * Self-Update anstoßen: lädt den aktuellen Stand und startet den Dienst neu.
 * Läuft als abgekoppelter Prozess weiter, auch wenn dieser Node-Prozess
 * gleich beendet wird. Wirft, wenn die Voraussetzungen fehlen.
 */
export function startSelfUpdate(installDir) {
  if (updating) throw new Error('Es läuft bereits ein Update.');
  const script = path.join(installDir, 'deploy', 'self-update.sh');
  if (!fs.existsSync(script)) {
    throw new Error('Update-Skript deploy/self-update.sh fehlt.');
  }
  // Skript in eine tmp-Kopie auslagern: rsync ersetzt deploy/self-update.sh
  // mitten im Lauf – aus /opt/beampi gestartet würde die Shell dann beim
  // zeilenweisen Nachladen Müll lesen. Die Kopie bleibt unangetastet.
  const tmpScript = path.join(os.tmpdir(), `beampi-self-update-${process.pid}.sh`);
  fs.copyFileSync(script, tmpScript);
  fs.chmodSync(tmpScript, 0o755);

  updating = true;
  const child = spawn(
    '/bin/bash',
    [tmpScript, installDir, String(process.pid), TARBALL_URL],
    { detached: true, stdio: 'ignore' }
  );
  child.on('error', () => { updating = false; });
  child.on('exit', (code, signal) => {
    updating = false;
    if (code && code !== 0) {
      console.error(`Self-Update wurde beendet (Code ${code}${signal ? `, Signal ${signal}` : ''}).`);
    }
  });
  child.unref();
}
