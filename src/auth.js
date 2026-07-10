import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_KEYLEN = 64;
const MAX_SESSIONS = 30;
export const SESSION_MAX_AGE_S = 180 * 24 * 60 * 60; // 180 Tage – "Anmeldung merken"

/**
 * Benutzer + Sessions in data/auth.json. Erstanmeldung: admin / beampi,
 * danach wird ein Passwortwechsel erzwungen (must_change_password).
 */
export class Auth {
  #file;
  #state;
  #fileSignature = null;

  constructor(dataDir) {
    this.#file = path.join(dataDir, 'auth.json');
    this.#state = this.#readState();
    if (!this.#state?.password_hash) {
      const salt = crypto.randomBytes(16).toString('hex');
      this.#state = {
        username: 'admin',
        salt,
        password_hash: this.#hash('beampi', salt),
        must_change_password: true,
        sessions: {},
      };
      this.#save();
    }
    this.#normalizeState();
  }

  #readState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      const stat = fs.statSync(this.#file);
      this.#fileSignature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      return state;
    } catch {
      return null;
    }
  }

  #normalizeState() {
    if (!this.#state.sessions || typeof this.#state.sessions !== 'object' || Array.isArray(this.#state.sessions)) {
      this.#state.sessions = {};
    }
  }

  /** Übernimmt Passwort-/Session-Änderungen eines parallel laufenden CLI-Tools. */
  #reloadIfChanged() {
    let signature;
    try {
      const stat = fs.statSync(this.#file);
      signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      // Eine atomar ersetzte Datei kann für einen sehr kurzen Moment fehlen.
      // Dann den gültigen In-Memory-Zustand behalten und später erneut prüfen.
      return;
    }
    if (signature === this.#fileSignature) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      if (!state?.password_hash || typeof state.salt !== 'string') return;
      this.#state = state;
      this.#fileSignature = signature;
      this.#normalizeState();
    } catch {
      // Eine unvollständige/externe Datei nie über den gültigen Zustand legen.
    }
  }

  #hash(password, salt) {
    return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  }

  #save() {
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
    const stat = fs.statSync(this.#file);
    this.#fileSignature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }

  get username() {
    this.#reloadIfChanged();
    return this.#state.username;
  }

  get mustChangePassword() {
    this.#reloadIfChanged();
    return Boolean(this.#state.must_change_password);
  }

  verifyCredentials(username, password) {
    this.#reloadIfChanged();
    if (typeof username !== 'string' || typeof password !== 'string') return false;
    const expected = Buffer.from(this.#state.password_hash, 'hex');
    const actual = Buffer.from(this.#hash(password, this.#state.salt), 'hex');
    const userOk = username.trim().toLowerCase() === this.#state.username.toLowerCase();
    const passOk = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    return userOk && passOk;
  }

  /** Setzt ein neues Passwort und beendet alle anderen Sessions. */
  setPassword(newPassword, keepSessionToken = null) {
    this.#reloadIfChanged();
    const salt = crypto.randomBytes(16).toString('hex');
    this.#state.salt = salt;
    this.#state.password_hash = this.#hash(newPassword, salt);
    this.#state.must_change_password = false;
    for (const token of Object.keys(this.#state.sessions)) {
      if (token !== keepSessionToken) delete this.#state.sessions[token];
    }
    this.#save();
  }

  createSession() {
    this.#reloadIfChanged();
    const token = crypto.randomBytes(32).toString('hex');
    this.#state.sessions[token] = { created: Date.now() };
    // Alte Sessions begrenzen (älteste zuerst entfernen)
    const tokens = Object.entries(this.#state.sessions).sort((a, b) => a[1].created - b[1].created);
    while (tokens.length > MAX_SESSIONS) {
      const [oldest] = tokens.shift();
      delete this.#state.sessions[oldest];
    }
    this.#save();
    return token;
  }

  validateSession(token) {
    this.#reloadIfChanged();
    if (!token) return false;
    const session = this.#state.sessions[token];
    if (!session) return false;
    if (Date.now() - session.created > SESSION_MAX_AGE_S * 1000) {
      delete this.#state.sessions[token];
      this.#save();
      return false;
    }
    return true;
  }

  destroySession(token) {
    this.#reloadIfChanged();
    if (token && this.#state.sessions[token]) {
      delete this.#state.sessions[token];
      this.#save();
    }
  }
}

/** Einfache Brute-Force-Bremse pro IP: 8 Fehlversuche → 5 Minuten Sperre. */
export class LoginThrottle {
  #attempts = new Map();

  check(ip) {
    const entry = this.#attempts.get(ip);
    if (!entry) return true;
    if (entry.blockedUntil && Date.now() < entry.blockedUntil) return false;
    return true;
  }

  fail(ip) {
    const entry = this.#attempts.get(ip) ?? { count: 0, blockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= 8) {
      entry.blockedUntil = Date.now() + 5 * 60 * 1000;
      entry.count = 0;
    }
    this.#attempts.set(ip, entry);
  }

  succeed(ip) {
    this.#attempts.delete(ip);
  }
}
