import { execFile } from 'node:child_process';

// System-(ALSA-)Lautstärke des Standard-Audiogeräts über `amixer`. Damit gilt
// der Lautstärkeregler für die KOMPLETTE Systemlautstärke (z. B. HDMI-Ausgang),
// nicht nur für die Software-Lautstärke von mpv. Reines ALSA (kein PulseAudio/
// PipeWire) – wie auf einem headless Raspberry Pi üblich.

const PREFERRED = ['Master', 'PCM', 'Headphone', 'HDMI', 'Digital', 'Speaker'];
let controlPromise = null;

function run(args) {
  return new Promise((resolve) => {
    execFile('amixer', args, { timeout: 4000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Ermittelt den passenden ALSA-Simple-Control (einmal, gecacht). */
function getControl() {
  if (!controlPromise) {
    controlPromise = (async () => {
      const out = await run(['scontrols']);
      if (!out) return null;
      const names = [...out.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      if (names.length === 0) return null;
      for (const pref of PREFERRED) {
        const hit = names.find((n) => n.toLowerCase() === pref.toLowerCase());
        if (hit) return hit;
      }
      return names[0];
    })();
  }
  return controlPromise;
}

/**
 * Setzt die System-Lautstärke des Standard-Audiogeräts.
 * Stummschalten wird als 0 % umgesetzt (HDMI-Controls haben oft keinen
 * Mute-Schalter); die eigentliche Lautstärke bleibt in den Einstellungen
 * gespeichert und wird beim Aufheben wiederhergestellt.
 *
 * @param {number} volume 0–100
 * @param {boolean} muted true → 0 %
 */
export async function setSystemVolume(volume, muted) {
  const control = await getControl();
  if (!control) {
    console.warn('Keine ALSA-Lautstärkeregelung gefunden (amixer) – Lautstärke nicht änderbar.');
    return;
  }
  const pct = muted ? 0 : Math.max(0, Math.min(100, Math.round(volume)));
  // -M: an die menschliche Wahrnehmung angepasste Skala (wie ein Desktop-Regler)
  await run(['-M', '-q', 'sset', control, `${pct}%`]);
}
