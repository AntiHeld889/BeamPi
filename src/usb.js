import fs from 'node:fs';
import path from 'node:path';
import { isVideoFile } from './videos.js';

// Bevorzugter Mountpunkt unseres eigenen Mount-Dienstes (deploy/mount-usb.sh),
// danach die typischen Desktop-Automount-Orte als Rückfall.
const FIXED_MOUNT = '/media/beampi-usb';
const AUTOMOUNT_PARENTS = ['/media/pi', '/media', '/mnt'];

const CONFIG_FILE = 'beampi.txt';
const VIDEOS_DIR = 'Videos';
const LOOP_BASENAME = 'loop';
const DEFAULT_INTERVAL_S = 30;
const MAX_INTERVAL_S = 3660;

/** Wie der Auto-Trigger-Dialog: 1 s bis 60 min 60 s. */
function clampInterval(seconds) {
  if (!Number.isFinite(seconds)) return DEFAULT_INTERVAL_S;
  return Math.min(MAX_INTERVAL_S, Math.max(1, Math.round(seconds)));
}

/** Natürliche Sortierung, damit 1,2,10 statt 1,10,2 herauskommt. */
function naturalCompare(a, b) {
  // Tie-Breaker über den Roh-Vergleich, damit z. B. 001.mp4/001.MP4 stabil bleibt
  return a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

async function isDir(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Mögliche Mount-Roots in Prioritätsreihenfolge, dedupliziert. */
async function candidateRoots() {
  const roots = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      roots.push(p);
    }
  };
  add(FIXED_MOUNT);
  for (const parent of AUTOMOUNT_PARENTS) {
    let entries;
    try {
      entries = await fs.promises.readdir(parent);
    } catch {
      continue;
    }
    for (const name of entries.sort(naturalCompare)) add(path.join(parent, name));
  }
  return roots;
}

/**
 * beampi.txt parsen: Zeilen "minuten=1" und "sekunden=30" (auch ":" als
 * Trenner, Groß/Klein egal, CRLF/BOM von Windows werden toleriert).
 * @returns {{interval_s: number, found: boolean}}
 */
async function parseConfig(root) {
  let raw;
  try {
    raw = await fs.promises.readFile(path.join(root, CONFIG_FILE), 'utf8');
  } catch {
    return { interval_s: DEFAULT_INTERVAL_S, found: false };
  }
  // min/sek getrennt von der Einzahlangabe (wartezeit/intervall) einsammeln,
  // damit die Reihenfolge der Zeilen egal ist und min/sek immer Vorrang hat.
  let minutes = null;
  let seconds = null;
  let single = null;
  for (const line of raw.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.trim().match(/^([a-zA-ZäöüÄÖÜ]+)\s*[:=]\s*(\d+)/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = Number(m[2]);
    if (key.startsWith('min')) minutes = value;
    else if (key.startsWith('sek') || key.startsWith('sec')) seconds = value;
    else if (key.startsWith('wartezeit') || key.startsWith('intervall')) single = value;
  }
  if (minutes !== null || seconds !== null) {
    return { interval_s: clampInterval((minutes ?? 0) * 60 + (seconds ?? 0)), found: true };
  }
  if (single !== null) return { interval_s: clampInterval(single), found: true };
  return { interval_s: DEFAULT_INTERVAL_S, found: false };
}

/**
 * Sucht einen vorbereiteten BeamPi-USB-Stick (Ordner "Videos" mit Videos darin)
 * und liest dessen Konfiguration aus.
 *
 * Asynchron (fs.promises), damit ein langsamer/hängender USB-Mount nicht den
 * Node-Event-Loop blockiert – wichtig für den periodischen Hotplug-Watcher.
 *
 * @param {string[]} [roots] zu prüfende Mount-Roots (Standard: Auto-Erkennung)
 * @returns {Promise<null | {
 *   root: string, videosDir: string, loopVideo: string|null,
 *   videos: string[], intervalS: number, configFound: boolean
 * }>}
 */
export async function detectUsbShow(roots) {
  const list = roots ?? (await candidateRoots());
  for (const root of list) {
    const videosDir = path.join(root, VIDEOS_DIR);
    if (!(await isDir(videosDir))) continue;

    let entries;
    try {
      entries = await fs.promises.readdir(videosDir, { withFileTypes: true });
    } catch {
      continue;
    }

    let loopVideo = null;
    const videos = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isVideoFile(entry.name)) continue;
      const stem = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
      if (stem === LOOP_BASENAME) {
        loopVideo = entry.name; // relativer Name im Videos-Ordner
      } else {
        videos.push(entry.name);
      }
    }
    videos.sort(naturalCompare);

    // Ohne abspielbares Material ist der Stick uninteressant – weitersuchen.
    if (videos.length === 0 && !loopVideo) continue;

    const config = await parseConfig(root);
    return {
      root,
      videosDir,
      loopVideo,
      videos,
      intervalS: config.interval_s,
      configFound: config.found,
    };
  }
  return null;
}
