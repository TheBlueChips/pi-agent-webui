/*
 * Auto-provision a local whisper.cpp server for speech-to-text.
 *
 * On launch: if something already listens on WHISPER_PORT, reuse it.
 * Otherwise (first run) download the whisper.cpp Windows binaries and a ggml
 * model, extract them into bridge/whisper/, and start the server. All failures
 * are non-fatal — the UI falls back to browser speech recognition.
 *
 * Env: WHISPER_PORT (8081), WHISPER_MODEL (ggml-base.en.bin), AUTO_WHISPER=0 to disable.
 */
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFile, execSync } = require('child_process');

const WHISPER_PORT = process.env.WHISPER_PORT || '8081';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'ggml-base.en.bin';
const VENDOR_DIR = path.join(__dirname, 'whisper');
// Note: whisper.cpp's semantic-version releases ship source only; the Windows
// binaries are attached to the tagged nightly builds (b5130 etc.).
const BIN_ZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL}`;

// The whisper-server child we spawned (null if we reused an existing server or
// never started one). Kept so the bridge can stop it on shutdown.
let whisperProc = null;

function tcpReachable(port) {
  return new Promise((resolve) => {
    const s = net.connect(Number(port), '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      const mod = u.startsWith('https:') ? https : http;
      mod.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`${u} -> HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        const out = fs.createWriteStream(dest);
        let got = 0, lastPct = -100;
        res.on('data', (c) => {
          got += c.length;
          const pct = total ? Math.floor((got / total) * 100) : 0;
          if (pct >= lastPct + 10) { lastPct = pct; console.log(`  downloading ${path.basename(dest)} … ${pct}%`); }
        });
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      }).on('error', reject);
    };
    get(url, 0);
  });
}

function unzip(zip, destDir) {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${destDir}" -Force`],
      { timeout: 300000 }, (err) => (err ? reject(err) : resolve()));
  });
}

function findServerExe(dir) {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else files.push(p);
    }
  })(dir);
  return files.find((p) => /whisper[-.]?server(\.exe)?$/i.test(p))
    || files.find((p) => /(^|\\|\/)server\.exe$/i.test(p))
    || null;
}

async function startWhisper() {
  const url = `http://localhost:${WHISPER_PORT}/inference`;
  try {
    if (await tcpReachable(WHISPER_PORT)) {
      console.log(`whisper STT: reusing server already listening on port ${WHISPER_PORT}`);
      return url;
    }
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    let serverExe = findServerExe(VENDOR_DIR);
    const model = path.join(VENDOR_DIR, WHISPER_MODEL);
    if (!serverExe) {
      console.log('whisper STT: first run — downloading whisper.cpp binaries (~200 MB, once)…');
      const zip = path.join(VENDOR_DIR, 'whisper-bin-x64.zip');
      await download(BIN_ZIP_URL, zip);
      await unzip(zip, VENDOR_DIR);
      fs.rmSync(zip, { force: true });
      serverExe = findServerExe(VENDOR_DIR);
    }
    if (!serverExe) {
      console.log('whisper STT: server binary not found after download — skipping (browser voice stays available)');
      return null;
    }
    if (!fs.existsSync(model)) {
      console.log(`whisper STT: downloading model ${WHISPER_MODEL}…`);
      await download(MODEL_URL, model);
    }
    const child = spawn(serverExe, ['-m', model, '--port', String(WHISPER_PORT), '--inference-path', '/inference'], {
      cwd: path.dirname(serverExe),
      stdio: 'ignore',
    });
    child.on('error', (e) => console.log('whisper STT: failed to start:', e.message));
    whisperProc = child;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await tcpReachable(WHISPER_PORT)) break;
    }
    if (await tcpReachable(WHISPER_PORT)) {
      console.log(`whisper STT: serving ${WHISPER_MODEL} at ${url}`);
      return url;
    }
    console.log('whisper STT: server did not come up — browser voice fallback stays available');
    return null;
  } catch (e) {
    console.log('whisper STT: setup skipped (' + e.message + ')');
    return null;
  }
}

// Stop the whisper server we started. Only acts if we actually spawned one
// (reused servers are left alone). Synchronous so it is safe to call from a
// process 'exit' handler.
function stopWhisper() {
  if (!whisperProc) return;
  const p = whisperProc;
  whisperProc = null;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: 'ignore' });
    } else {
      p.kill('SIGKILL');
    }
  } catch { /* already gone */ }
}

module.exports = { startWhisper, stopWhisper };
