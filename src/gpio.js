import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const RETRY_DELAY_MS = 3000;

/**
 * Überwacht einen Taster an einem GPIO-Pin (BCM-Nummerierung).
 *
 * Verdrahtung: Taster zwischen GPIO-Pin und GND. Der interne Pull-up wird
 * aktiviert, ein Tastendruck erzeugt eine fallende Flanke → 'press'-Event.
 *
 * Implementiert über `gpiomon` (libgpiod), damit kein natives Node-Addon
 * kompiliert werden muss. Unterstützt libgpiod v1 und v2.
 */
export class GpioButton extends EventEmitter {
  #proc = null;
  #stopped = false;
  #retryTimer = null;
  #pin = null;
  #minIntervalMs = 250;
  #lastEmit = 0;
  #lastPressAt = null;
  #error = null;
  #running = false;
  #versionMajor = null;
  #generation = 0;

  /** @param {number|null} pin BCM-Pin oder null zum Deaktivieren */
  configure(pin, minIntervalMs = 250) {
    this.#minIntervalMs = Math.max(50, minIntervalMs);
    if (pin === this.#pin && this.#proc) return;
    this.#teardown();
    this.#pin = pin;
    this.#error = null;
    if (pin !== null) this.#start();
  }

  disable() {
    this.#teardown();
    this.#pin = null;
    this.#error = null;
  }

  stop() {
    this.#stopped = true;
    this.#teardown();
  }

  getStatus() {
    return {
      pin: this.#pin,
      running: this.#running,
      error: this.#error,
      last_press: this.#lastPressAt,
    };
  }

  #teardown() {
    this.#generation += 1; // laufende async #start()-Aufrufe entwerten
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    if (this.#proc) {
      this.#proc.removeAllListeners();
      this.#proc.stdout?.removeAllListeners();
      this.#proc.stderr?.removeAllListeners();
      this.#proc.kill('SIGTERM');
      this.#proc = null;
    }
    this.#running = false;
  }

  #detectVersion() {
    return new Promise((resolve) => {
      execFile('gpiomon', ['--version'], (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const match = String(stdout).match(/v(\d+)\./);
        resolve(match ? Number(match[1]) : 1);
      });
    });
  }

  async #start() {
    if (this.#stopped || this.#pin === null) return;
    const generation = this.#generation;

    if (this.#versionMajor === null) {
      this.#versionMajor = await this.#detectVersion();
      // Wurde während des Wartens neu konfiguriert, diesen Start abbrechen
      if (generation !== this.#generation || this.#stopped) return;
      if (this.#versionMajor === null) {
        this.#error = 'gpiomon wurde nicht gefunden – Paket "gpiod" installieren.';
        console.error(`GPIO: ${this.#error}`);
        return;
      }
    }

    const pin = this.#pin;
    const args =
      this.#versionMajor >= 2
        ? ['--bias', 'pull-up', '--edges', 'falling', '--debounce-period', '20ms', `GPIO${pin}`]
        : ['--bias=pull-up', '--falling-edge', 'gpiochip0', String(pin)];

    let proc;
    try {
      proc = spawn('gpiomon', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.#error = `gpiomon konnte nicht gestartet werden: ${err.message}`;
      this.#scheduleRetry();
      return;
    }
    this.#proc = proc;
    this.#error = null;

    let stdoutBuffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this.#running = true;
      stdoutBuffer += chunk;
      let index;
      while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (/falling/i.test(line)) this.#onFallingEdge();
      }
    });

    let stderrText = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrText = (stderrText + chunk).slice(-500);
    });

    proc.on('error', (err) => {
      this.#error = `gpiomon-Fehler: ${err.message}`;
    });

    proc.on('spawn', () => {
      this.#running = true;
      console.log(`GPIO: Taster-Überwachung auf GPIO${pin} gestartet (gpiomon v${this.#versionMajor}).`);
    });

    proc.on('exit', (code) => {
      if (this.#proc !== proc) return;
      this.#proc = null;
      this.#running = false;
      if (this.#stopped || this.#pin === null) return;
      this.#error = stderrText.trim() || `gpiomon wurde beendet (Code ${code}).`;
      console.error(`GPIO: ${this.#error}`);
      this.#scheduleRetry();
    });
  }

  #scheduleRetry() {
    if (this.#stopped || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#start();
    }, RETRY_DELAY_MS);
  }

  #onFallingEdge() {
    const now = Date.now();
    if (now - this.#lastEmit < this.#minIntervalMs) return;
    this.#lastEmit = now;
    this.#lastPressAt = new Date(now).toISOString();
    this.emit('press');
  }
}
