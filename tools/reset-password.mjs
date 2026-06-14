#!/usr/bin/env node
//
// Passwort-Verwaltung für BeamPi von der Kommandozeile.
//
//   npm run set-password -- "MeinNeuesGeheim"   neues Passwort direkt setzen
//   npm run reset-password                       zurück auf admin/beampi (Zwangswechsel)
//
// Direkt aufrufbar:
//   node tools/reset-password.mjs "Passwort"     Passwort setzen
//   node tools/reset-password.mjs --default      auf Werkszustand zurücksetzen
//
// Nutzt dasselbe data/auth.json wie der Server (BEAMPI_DATA_DIR oder ./data).
// Alle offenen Sitzungen werden dabei beendet. Ein Server-Neustart ist nicht
// nötig – die Datei wird beim nächsten Request frisch gelesen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from '../src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BEAMPI_DATA_DIR || path.join(__dirname, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

const MIN_LENGTH = 6;
const DEFAULT_PASSWORD = 'beampi';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const arg = process.argv[2];

if (arg === undefined || arg === '--help' || arg === '-h') {
  console.log(`BeamPi-Passwort verwalten

  node tools/reset-password.mjs "NeuesPasswort"   Passwort direkt setzen (mind. ${MIN_LENGTH} Zeichen)
  node tools/reset-password.mjs --default         auf admin/${DEFAULT_PASSWORD} zurücksetzen (Zwangswechsel)

  Datenverzeichnis: ${DATA_DIR}`);
  process.exit(arg === undefined ? 1 : 0);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

if (arg === '--default') {
  // Werkszustand: Datei löschen, der Auth-Konstruktor legt admin/beampi neu an
  try {
    fs.rmSync(AUTH_FILE, { force: true });
  } catch (err) {
    fail(`auth.json konnte nicht gelöscht werden: ${err.message}`);
  }
  new Auth(DATA_DIR); // erzeugt Default-State (admin/beampi, must_change_password)
  console.log(`✓ Zurückgesetzt auf  admin / ${DEFAULT_PASSWORD}  – beim nächsten Login wird ein Passwortwechsel erzwungen.`);
  console.log('  Alle bestehenden Sitzungen sind ungültig.');
  process.exit(0);
}

// Sonst: arg ist das neue Passwort
const newPassword = arg;
if (newPassword.length < MIN_LENGTH) {
  fail(`Passwort muss mindestens ${MIN_LENGTH} Zeichen lang sein.`);
}
if (newPassword === DEFAULT_PASSWORD) {
  fail(`„${DEFAULT_PASSWORD}" ist das Standardpasswort und nicht zulässig – bitte ein anderes wählen.`);
}

const auth = new Auth(DATA_DIR);
auth.setPassword(newPassword); // setzt Hash, must_change=false, beendet alle Sessions
console.log(`✓ Passwort für Benutzer „${auth.username}" gesetzt. Alle bestehenden Sitzungen wurden beendet.`);
