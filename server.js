#!/usr/bin/env node
'use strict';

// scrub — local transcript editor with audio scrubbing.
// Zero dependencies. Reads and writes files on disk; nothing leaves the machine.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PUBLIC_DIR = path.join(__dirname, 'public');

const AUDIO_TYPES = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------- config

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function expand(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function die(msg) {
  console.error('\nscrub: ' + msg + '\n');
  console.error('Usage:');
  console.error('  node server.js --audio <file> --transcript <file> [--port 4173] [--no-open]');
  console.error('  node server.js --config <scrub.json>');
  console.error('  node server.js            (reads ./scrub.json)\n');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

let fileCfg = {};
let cfgDir = process.cwd();
const cfgPath = args.config ? expand(args.config) : path.join(process.cwd(), 'scrub.json');
if (fs.existsSync(cfgPath)) {
  try {
    fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfgDir = path.dirname(path.resolve(cfgPath));
  } catch (e) {
    die('could not parse ' + cfgPath + ': ' + e.message);
  }
} else if (args.config) {
  die('config not found: ' + cfgPath);
}

// Paths in a config file resolve relative to that file; CLI paths relative to cwd.
const resolveFrom = (base) => (p) => (p ? path.resolve(base, expand(p)) : null);
const audioPath = args.audio
  ? resolveFrom(process.cwd())(args.audio)
  : resolveFrom(cfgDir)(fileCfg.audio);
const transcriptPath = args.transcript
  ? resolveFrom(process.cwd())(args.transcript)
  : resolveFrom(cfgDir)(fileCfg.transcript);

if (!audioPath) die('no audio file given');
if (!transcriptPath) die('no transcript file given');
if (!fs.existsSync(audioPath)) die('audio file not found: ' + audioPath);
if (!fs.existsSync(transcriptPath)) die('transcript not found: ' + transcriptPath);

const audioType = AUDIO_TYPES[path.extname(audioPath).toLowerCase()] || 'application/octet-stream';
const startPort = Number(args.port || fileCfg.port || 4173);
const shouldOpen = !args['no-open'];

// ---------------------------------------------------------------- helpers

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}

function json(res, code, obj) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Stream the audio with byte-range support — without it, seeking doesn't work.
function serveAudio(req, res) {
  const stat = fs.statSync(audioPath);
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': audioType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(audioPath).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); res.end(); return; }

  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null) { // suffix range: last N bytes
    start = Math.max(0, stat.size - (end || 0));
    end = stat.size - 1;
  }
  if (end === null || end >= stat.size) end = stat.size - 1;

  if (start > end || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
    res.end();
    return;
  }

  res.writeHead(206, {
    'Content-Type': audioType,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(audioPath, { start, end }).pipe(res);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  // Refuse anything that escapes public/
  if (!full.startsWith(PUBLIC_DIR + path.sep)) { send(res, 403, 'text/plain', 'forbidden'); return; }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { send(res, 404, 'text/plain', 'not found'); return; }
  const type = STATIC_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
  send(res, 200, type, fs.readFileSync(full));
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  try {
    if (route === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        audioName: path.basename(audioPath),
        transcriptName: path.basename(transcriptPath),
        transcriptPath,
        format: path.extname(transcriptPath).toLowerCase().replace('.', '') || 'md',
      });
    }

    if (route === '/api/transcript' && req.method === 'GET') {
      const stat = fs.statSync(transcriptPath);
      return json(res, 200, {
        text: fs.readFileSync(transcriptPath, 'utf8'),
        mtime: stat.mtimeMs,
      });
    }

    if (route === '/api/transcript' && req.method === 'PUT') {
      const payload = JSON.parse(await readBody(req));
      const stat = fs.statSync(transcriptPath);

      // Guard against clobbering an edit made in another editor since we loaded.
      if (payload.baseMtime && Math.abs(payload.baseMtime - stat.mtimeMs) > 1 && !payload.force) {
        return json(res, 409, { error: 'file changed on disk since it was loaded', mtime: stat.mtimeMs });
      }

      // One-time backup, so the original is always recoverable.
      const backup = transcriptPath + '.orig';
      if (!fs.existsSync(backup)) fs.copyFileSync(transcriptPath, backup);

      fs.writeFileSync(transcriptPath, payload.text, 'utf8');
      const after = fs.statSync(transcriptPath);
      console.log(`saved ${path.basename(transcriptPath)} (${after.size} bytes)`);
      return json(res, 200, { ok: true, mtime: after.mtimeMs, bytes: after.size });
    }

    if (route === '/audio') return serveAudio(req, res);

    if (req.method === 'GET') return serveStatic(res, route);

    send(res, 405, 'text/plain', 'method not allowed');
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err && err.message || err) });
  }
});

// ---------------------------------------------------------------- listen

function listen(port, attempt) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) return listen(port + 1, attempt + 1);
    die('could not start server: ' + err.message);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log('\n  scrub');
    console.log('  audio      ' + audioPath);
    console.log('  transcript ' + transcriptPath);
    console.log('  →          ' + url + '\n');
    if (shouldOpen && process.platform === 'darwin') execFile('open', [url], () => {});
    else if (shouldOpen && process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else if (shouldOpen) execFile('xdg-open', [url], () => {});
  });
}

listen(startPort, 0);
