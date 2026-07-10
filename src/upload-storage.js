import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { resolveContainedPath } from './paths.js';

export function sanitizeFilename(original) {
  // multer liefert Dateinamen als latin1 – nach UTF-8 zurückwandeln (Umlaute!)
  let name = original;
  try {
    const decoded = Buffer.from(original, 'latin1').toString('utf8');
    if (!decoded.includes('�')) name = decoded;
  } catch {
    /* Original behalten */
  }
  name = path.basename(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (name.startsWith('.')) name = `_${name.slice(1)}`;
  return name;
}

function openUnique(dir, sanitized, callback, counter = 1) {
  const ext = path.extname(sanitized);
  const stem = path.basename(sanitized, ext);
  const candidate = counter === 1 ? sanitized : `${stem} (${counter})${ext}`;
  const target = path.join(dir, candidate);
  fs.open(target, 'wx', (err, fd) => {
    if (err?.code === 'EEXIST') return openUnique(dir, sanitized, callback, counter + 1);
    callback(err, { fd, candidate, target });
  });
}

/** Multer-Storage mit exklusiver Namensvergabe und Bereinigung bei Abbrüchen. */
export function createUploadStorage(getVideoDirectory) {
  return {
    _handleFile(req, file, cb) {
      let dir;
      try {
        // Query-Parameter funktioniert unabhängig von der Feld-Reihenfolge im
        // Multipart-Stream (req.body ist nur gefüllt, wenn es vor den Dateien kommt).
        const sub = String(req.query?.subdirectory ?? req.body?.subdirectory ?? '').trim();
        dir = resolveContainedPath(getVideoDirectory(), sub);
        if (!dir) return cb(new Error('Der Zielordner muss innerhalb des Videoverzeichnisses liegen.'));
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return cb(err);
      }

      const sanitized = sanitizeFilename(file.originalname);
      openUnique(dir, sanitized, (openErr, opened) => {
        if (openErr) return cb(openErr);
        const out = fs.createWriteStream(opened.target, { fd: opened.fd, autoClose: true });
        pipeline(file.stream, out, (err) => {
          if (err) {
            fs.rm(opened.target, { force: true }, () => cb(err));
            return;
          }
          cb(null, {
            destination: dir,
            filename: opened.candidate,
            path: opened.target,
            size: out.bytesWritten,
          });
        });
      });
    },

    _removeFile(req, file, cb) {
      fs.rm(file.path, { force: true }, cb);
    },
  };
}
