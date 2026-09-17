/*
 * Pi Agent WebUI bridge.
 *
 * Spawns one `pi --mode rpc` subprocess per connected browser tab and relays
 * JSON lines between the browser (WebSocket) and the agent (stdin/stdout).
 * Also serves the static WebUI and a small HTTP API for session discovery.
 *
 * Env vars:
 *   PORT           HTTP/WS port                (default 3000)
 *   PI_COMMAND     agent command line          (default "pi --mode rpc")
 *                  e.g. "node mock_agent.js" for testing without a real pi install
 *   WORKSPACE_DIR  cwd for the agent process   (default cwd, /workspace in Docker)
 *   PI_SESSION_DIR session dir for listing     (default ~/.pi/agent/sessions)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execSync } = require('child_process');
const { pathToFileURL } = require('url');
const { WebSocketServer } = require('ws');
const { startWhisper, stopWhisper } = require('./whisper_boot');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PI_COMMAND = process.env.PI_COMMAND || 'pi --mode rpc';
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.cwd();
// Session dir for listing. Either a normal path, or "docker:<container>:<path>"
// to list sessions inside a container via `docker exec` (used when the pi
// agent runs in an existing container, e.g. PI_COMMAND="docker exec -i ctr pi --mode rpc").
const SESSION_DIR =
  process.env.PI_SESSION_DIR || path.join(os.homedir(), '.pi', 'agent', 'sessions');
const WEB_DIR = path.join(__dirname, '..', 'web');
let whisperUrl = null; // set once the local whisper STT server (if any) is up

function parseSessionDir() {
  if (SESSION_DIR.startsWith('docker:')) {
    const rest = SESSION_DIR.slice('docker:'.length);
    const i = rest.indexOf(':');
    return { container: rest.slice(0, i), dir: rest.slice(i + 1) };
  }
  return null;
}

// ---------------------------------------------------------------- builtin slash commands

// Fallback list mirroring pi's BUILTIN_SLASH_COMMANDS, used only if the installed
// pi package can't be located. The live list is loaded from the package so new
// commands pi adds in future releases show up automatically.
const FALLBACK_BUILTIN_COMMANDS = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model', argumentHint: '<provider/model>' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'thinking', description: 'Set thinking level', argumentHint: '<level>' },
  { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling' },
  { name: 'export', description: 'Export session (HTML default, or .jsonl)' },
  { name: 'import', description: 'Import and resume a session from JSONL' },
  { name: 'share', description: 'Share session as a secret GitHub gist' },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name', argumentHint: '<name>' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'changelog', description: 'Show changelog entries' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'fork', description: 'Create a new fork from a previous user message' },
  { name: 'clone', description: 'Duplicate the current session' },
  { name: 'trust', description: 'Save project trust decision' },
  { name: 'login', description: 'Configure provider authentication', argumentHint: '<provider>' },
  { name: 'logout', description: 'Remove provider authentication' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, themes' },
  { name: 'quit', description: 'Quit pi' },
];

// Locate the installed pi package and read its BUILTIN_SLASH_COMMANDS so the
// WebUI can offer every current (and future) command. Tries a local install,
// the global npm root, and the path implied by PI_COMMAND, then falls back.
async function loadBuiltinCommands() {
  const candidates = [];
  try { candidates.push(require.resolve('@earendil-works/pi-coding-agent/dist/core/slash-commands.js')); } catch { /* not local */ }
  try {
    const g = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (g) candidates.push(path.join(g, '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'slash-commands.js'));
  } catch { /* no npm */ }
  try {
    const cmd0 = (PI_COMMAND.split(/\s+/)[0] || '').trim();
    if (cmd0 && !cmd0.includes(' ') && !cmd0.startsWith('docker')) {
      const which = isWin ? 'where' : 'which';
      const bin = execSync(`${which} ${JSON.stringify(cmd0)}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().split(/\r?\n/)[0];
      if (bin) candidates.push(path.resolve(path.dirname(bin), '..', '..', 'dist', 'core', 'slash-commands.js'));
    }
  } catch { /* not a direct binary */ }
  for (const file of candidates) {
    try {
      const m = await import(pathToFileURL(file).href);
      if (m && Array.isArray(m.BUILTIN_SLASH_COMMANDS) && m.BUILTIN_SLASH_COMMANDS.length) {
        return m.BUILTIN_SLASH_COMMANDS.map((c) => ({
          name: c.name, description: c.description, argumentHint: c.argumentHint, source: 'builtin',
        }));
      }
    } catch { /* try next candidate */ }
  }
  return FALLBACK_BUILTIN_COMMANDS.map((c) => ({ ...c, source: 'builtin' }));
}
let builtinCommandsCache = null;

// ---------------------------------------------------------------- static + api

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, urlPath));
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/*
 * Best-effort session discovery. Session file format may evolve, so every
 * step is defensive — worst case the file name is the title.
 */

function execCapture(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false },
      (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Extract a display title from the head of one session file's content.
function titleFromHead(head) {
  let title = '';
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry && (entry.type === 'session' || entry.type === 'sessionStart')) {
      if (entry.name) title = entry.name;
      continue;
    }
    const msg = entry && (entry.message || entry.payload || entry);
    if (msg && msg.role === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
            ? msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
            : '');
      if (text && !title) return text.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return title;
}

function scanLocalSessions() {
  let files;
  try {
    files = fs.readdirSync(SESSION_DIR, { recursive: true })
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(SESSION_DIR, f));
  } catch {
    return [];
  }
  const sessions = [];
  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    let title = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      title = titleFromHead(buf.toString('utf8', 0, read));
    } catch {
      /* unreadable file — fall back to file name */
    }
    sessions.push({
      path: file,
      fileName: name,
      name: title || name.replace(/\.jsonl$/, ''),
      mtime: st.mtimeMs,
      size: st.size,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, 200);
}

async function scanDockerSessions(container, dir) {
  // Recursive "mtime size path" lines, newest first. find -printf is GNU; the
  // sandbox images are Debian-based so this holds.
  const statOut = await execCapture('docker', ['exec', container, 'sh', '-c',
    `find '${dir}' -name '*.jsonl' -printf '%T@ %s %p\\n' 2>/dev/null | sort -rn | head -200`]);
  if (!statOut.trim()) return [];
  const files = statOut.trim().split('\n').map((l) => {
    const [mtime, size, ...rest] = l.trim().split(' ');
    return {
      path: rest.join(' '),
      fileName: rest.join(' ').split('/').pop(),
      mtime: Math.floor(parseFloat(mtime) * 1000),
      size: parseInt(size, 10) || 0,
    };
  }).filter((f) => f.path.endsWith('.jsonl'));

  // Pull a title out of each file head in a single exec.
  const heads = await execCapture('docker', ['exec', container, 'sh', '-c',
    `for f in ${files.map((f) => `'${f.path}'`).join(' ')}; do` +
    ` echo "===PIWEBUI $f"; head -c 32768 "$f"; echo; done`], 30000);
  const titleByFile = {};
  for (const chunk of heads.split('===PIWEBUI ')) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) continue;
    const name = chunk.slice(0, nl).trim();
    titleByFile[name] = titleFromHead(chunk.slice(nl + 1));
  }
  return files.map((f) => ({
    path: f.path,
    fileName: f.fileName,
    name: titleByFile[f.path] || f.fileName.replace(/\.jsonl$/, ''),
    mtime: f.mtime,
    size: f.size,
  }));
}

async function scanSessions() {
  const remote = parseSessionDir();
  if (remote) {
    try {
      return await scanDockerSessions(remote.container, remote.dir);
    } catch {
      return [];
    }
  }
  return scanLocalSessions();
}

const SETTINGS_FILE = path.join(__dirname, '..', 'webui-settings.json');

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/ui-settings')) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          JSON.parse(body); // validate
          fs.writeFileSync(SETTINGS_FILE, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else {
      let data = {};
      try { data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* defaults */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }
    return;
  }
  if (req.url.startsWith('/api/sessions')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionDir: SESSION_DIR, sessions: await scanSessions() }));
    return;
  }
  if (req.url.startsWith('/api/config')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      workspace: WORKSPACE_DIR,
      sessionDir: SESSION_DIR,
      command: PI_COMMAND,
      whisperUrl: whisperUrl || null,
    }));
    return;
  }
  if (req.url.startsWith('/api/builtin-commands')) {
    if (!builtinCommandsCache) builtinCommandsCache = loadBuiltinCommands();
    const commands = await builtinCommandsCache;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ commands }));
    return;
  }
  if (req.url.startsWith('/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  serveStatic(req, res);
});

// ---------------------------------------------------------------- agent plumbing

const wss = new WebSocketServer({ server });
const agents = new Map(); // ws -> child process

const isWin = process.platform === 'win32';

// Kill a child and (on Windows) its whole process tree. `shell: true` spawns
// cmd.exe which then spawns the real agent, so a plain child.kill() would
// orphan the agent and keep it running in the background. taskkill /T kills
// the entire tree; on POSIX we kill the child's process group.
function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (isWin) {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* already gone */ }
}

function wsSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function startAgent(ws) {
  const child = spawn(PI_COMMAND, {
    shell: true, // pi is an npm .cmd shim on Windows; shell handles both platforms
    cwd: WORKSPACE_DIR,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !isWin, // POSIX: own process group so killTree can kill the whole tree
  });

  let buf = '';
  child.stdout.on('data', (d) => {
    // Protocol requires splitting on \n only (not U+2028/U+2029 like readline).
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        wsSend(ws, { bridge: 'agent_raw', line });
        continue;
      }
      wsSend(ws, { bridge: 'rpc', payload: parsed });
    }
  });

  child.stderr.on('data', (d) => {
    wsSend(ws, { bridge: 'agent_stderr', text: d.toString('utf8') });
  });

  child.on('error', (err) => {
    wsSend(ws, {
      bridge: 'agent_exit',
      error: `Failed to start "${PI_COMMAND}": ${err.message}. ` +
             `Is the pi coding agent installed and on PATH? (npm install -g @mariozechner/pi-coding-agent)`,
    });
  });

  child.on('exit', (code, signal) => {
    if (agents.get(ws) === child) agents.delete(ws);
    if (ws.readyState === ws.OPEN) {
      wsSend(ws, { bridge: 'agent_exit', code, signal });
    }
  });

  agents.set(ws, child);
  wsSend(ws, {
    bridge: 'agent_started',
    command: PI_COMMAND,
    workspace: WORKSPACE_DIR,
    sessionDir: SESSION_DIR,
  });
  return child;
}

wss.on('connection', (ws) => {
  startAgent(ws);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.bridge === 'restart') {
      const old = agents.get(ws);
      if (old) {
        agents.delete(ws);
        killTree(old);
      }
      // Give the old process a moment to release, then start a fresh one.
      setTimeout(() => startAgent(ws), 150);
      return;
    }
    if (msg.bridge) return; // bridge-level chatter is not forwarded
    const child = agents.get(ws);
    if (child && child.stdin.writable) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    } else {
      wsSend(ws, { bridge: 'agent_stderr', text: 'Agent process is not running.' });
    }
  });

  ws.on('close', () => {
    const child = agents.get(ws);
    if (child) {
      agents.delete(ws);
      killTree(child);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Pi Agent WebUI`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  agent command : ${PI_COMMAND}`);
  console.log(`  workspace     : ${WORKSPACE_DIR}`);
  console.log(`  session dir   : ${SESSION_DIR}`);
  if (process.env.AUTO_WHISPER !== '0') {
    startWhisper().then((u) => { whisperUrl = u; });
  }
});

// ---------------------------------------------------------------- shutdown

// Ctrl+C (SIGINT) or a stop signal (SIGTERM) should cleanly stop the agent
// subprocesses and the whisper server instead of leaving them running in the
// background. The 'exit' handler is a synchronous last resort that also covers
// "close the console window" on Windows, where the signal handlers may not get
// a chance to run.
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping Pi Agent WebUI — killing agent processes…');
  for (const child of agents.values()) killTree(child);
  stopWhisper();
  try { server.close(); } catch { /* ignore */ }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  for (const child of agents.values()) {
    try {
      if (isWin) execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  try { stopWhisper(); } catch { /* ignore */ }
});
