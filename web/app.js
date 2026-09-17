/* Pi Agent WebUI — talks to the bridge over WebSocket, which relays to
 * `pi --mode rpc` (JSONL over the agent's stdin/stdout). */
'use strict';

/* ───────────────────────── helpers ───────────────────────── */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Compact markdown renderer: fenced code, headings, lists, quotes,
 * bold/italic/inline-code/links. Everything is HTML-escaped first. */
function renderMarkdown(src) {
  const parts = [];
  const segments = String(src ?? '').split(/```/);
  segments.forEach((seg, i) => {
    if (i % 2 === 1) { // fenced code block (first line may be a language tag)
      const nl = seg.indexOf('\n');
      const body = nl >= 0 ? seg.slice(nl + 1) : seg;
      parts.push(`<div class="codebox"><button class="code-toggle" title="Collapse/expand code">&minus;</button><pre>${escapeHtml(body.replace(/\n$/, ''))}</pre></div>`);
      return;
    }
    const lines = seg.split('\n');
    let html = '', para = [], list = null, quote = [];
    const flushPara = () => {
      if (para.length) { html += `<p>${inlineMd(para.join('<br>'))}</p>`; para = []; }
    };
    const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((li) => `<li>${inlineMd(li)}</li>`).join('')}</${list.tag}>`; list = null; } };
    const flushQuote = () => { if (quote.length) { html += `<blockquote>${inlineMd(quote.join('<br>'))}</blockquote>`; quote = []; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };
    for (const line of lines) {
      const t = line.trimEnd();
      let m;
      if ((m = t.match(/^(#{1,3})\s+(.*)/))) { flushAll(); html += `<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`; }
      else if ((m = t.match(/^[-*]\s+(.*)/))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); }
      else if ((m = t.match(/^\d+[.)]\s+(.*)/))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); }
      else if ((m = t.match(/^>\s?(.*)/))) { flushPara(); flushList(); quote.push(m[1]); }
      else if (t === '') { flushAll(); }
      else { flushList(); flushQuote(); para.push(escapeHtml(t)); }
    }
    flushAll();
    parts.push(html);
  });
  return parts.join('');

  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, (_, c) => `<code class="inline">${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(?<!["'=])(\bhttps?:\/\/[^\s<]+)(?!["'])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
}

/* Plain text for TTS / clipboard: drop code blocks and markdown noise. */
function stripMarkdown(src) {
  return String(src ?? '')
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function timeStr(ts) {
  try { return new Date(ts ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function formatTok(n) {
  if (n == null || isNaN(n)) return null;
  return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
}

/* "↑ 8.8k read @ 312 t/s · ↓ 89 write @ 18.6 t/s · $0.0012"
 * writeSec = generation time, readSec = prompt-processing (prefill) time.
 * Read and write each get their own per-second metric. */
function usageStats(usage, writeSec, readSec) {
  if (!usage) return '';
  const read = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
  const write = usage.output || 0;
  const parts = [];
  if (read) {
    parts.push(`↑ ${formatTok(read)} read` +
      (readSec && readSec > 0.05 ? ` @ ${(read / readSec).toFixed(0)} t/s` : ''));
  }
  if (write) {
    parts.push(`↓ ${formatTok(write)} write` +
      (writeSec && writeSec > 0.05 ? ` @ ${(write / writeSec).toFixed(1)} t/s` : ''));
  }
  const cost = usage.cost && usage.cost.total;
  if (cost) parts.push(`$${Number(cost) < 0.01 ? Number(cost).toFixed(4) : Number(cost).toFixed(3)}`);
  return parts.join(' · ');
}

const asArray = (data, key) =>
  Array.isArray(data) ? data : (data && Array.isArray(data[key]) ? data[key] : []);

/* ───────────────────────── local settings ───────────────────────── */

const DEFAULT_SETTINGS = {
  agentName: 'pi',        // display name next to the agent's messages
  avatar: null,           // dataURL shown next to the agent's name
  ttsVoiceURI: null,      // preferred browser speechSynthesis voice
  ttsRate: 1.05,
  voiceAutoSend: false,   // send the composer automatically after voice input
  showThinking: true,     // show/hide thinking blocks
  autoExpandThinking: false, // render thinking blocks open by default
  autoExpandTools: false, // render tool call output open by default
  sttEndpoint: '',        // whisper-compatible transcription endpoint
  sttBackend: 'whisper',  // 'whisper' or 'browser'
  ttsBackend: 'browser',  // 'browser' | 'endpoint'
  ttsEndpoint: '',        // OpenAI-compatible /v1/audio/speech server (Piper etc.)
  ttsModel: 'piper',
  ttsVoiceName: '',
  themeAccent: null,      // custom accent color
  themeBg: null,          // background image (URL or dataURL)
};
let SET = { ...DEFAULT_SETTINGS };
try { Object.assign(SET, JSON.parse(localStorage.getItem('piwebui-settings') || '{}')); } catch { /* defaults */ }
let settingsLoaded = false;

function saveSettings() {
  applySettings();
  try { localStorage.setItem('piwebui-settings', JSON.stringify(SET)); } catch { /* cache only */ }
  // authoritative copy lives in webui-settings.json next to the project
  fetch('/api/ui-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SET),
  }).catch(() => {});
}

async function loadServerSettings() {
  try {
    const data = await fetch('/api/ui-settings').then((r) => r.json());
    if (data && Object.keys(data).length) {
      Object.assign(SET, data);
      applySettings();
    }
    settingsLoaded = true;
  } catch { /* offline bridge: keep cache */ }
}

function applySettings() {
  $('agent-title').textContent = SET.agentName || 'pi agent';
  document.title = `${SET.agentName || 'Pi agent'}`;
  const tts = $('btn-tts');
  tts.textContent = S.autoTts ? 'TTS on' : 'TTS off';
  tts.classList.toggle('on', S.autoTts);
  // reflect in already-rendered "who" lines
  document.querySelectorAll('.msg.assistant .who .agent-name-label').forEach((e) => {
    e.textContent = SET.agentName || 'pi';
  });
  document.querySelectorAll('.msg.assistant .who .avatar').forEach((e) => {
    if (SET.avatar) e.src = SET.avatar;
    else e.remove();
  });
  // settings dialog preview
  const prev = $('set-avatar-preview');
  if (SET.avatar) { prev.src = SET.avatar; prev.style.visibility = 'visible'; }
  else prev.style.visibility = 'hidden';
  // thinking blocks visibility
  document.body.classList.toggle('hide-thinking', SET.showThinking === false);
  const st = $('set-show-thinking');
  if (st) st.checked = SET.showThinking !== false;
  // theme
  const rootStyle = document.documentElement.style;
  if (SET.themeAccent) {
    rootStyle.setProperty('--accent', SET.themeAccent);
    rootStyle.setProperty('--accent-dim', `color-mix(in srgb, ${SET.themeAccent} 35%, #171b22)`);
  } else {
    rootStyle.removeProperty('--accent');
    rootStyle.removeProperty('--accent-dim');
  }
  document.body.style.backgroundImage = SET.themeBg ? `url("${SET.themeBg}")` : '';
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundAttachment = 'fixed';
  // auto-expand state on already-rendered elements
  document.querySelectorAll('details.thinking').forEach((d) => { d.open = SET.autoExpandThinking === true; });
  document.querySelectorAll('.tool-card .tool-body').forEach((b) => {
    b.classList.toggle('hidden', SET.autoExpandTools !== true);
  });
}

/* ───────────────────────── state ───────────────────────── */

const S = {
  ws: null,
  reqId: 0,
  pending: new Map(),      // req id -> resolve fn
  commands: [],            // from get_commands (extension / prompt / skill)
  builtinCommands: [],     // from /api/builtin-commands (pi's built-in slash commands)
  forkable: [],            // from get_fork_messages: [{entryId, text}]
  state: {},               // last get_state payload
  isStreaming: false,
  compacting: false,        // true while a compaction is in flight
  compactionQueue: [],      // prompts queued while compacting (sent after it finishes)
  queue: { steering: [], followUp: [] },
  editMode: null,          // {entryId, originalText}
  attachments: [],         // [{data, mimeType, name}]
  models: [],
  levels: [],
  autoTts: false,
  speaking: false,
  stickToBottom: true,
  live: null,              // in-flight assistant render {root, text, thinking, tools}
  toolCards: new Map(),    // toolCallId -> {card, body, stateEl}
  bashCards: new Map(),    // bash req id -> {body}
  initialized: false,
  totals: { read: 0, write: 0 },  // session token totals
};

const chat = $('chat');

/* ───────────────────────── websocket / rpc ───────────────────────── */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;

  ws.onopen = () => {
    setConn('on');
    hideBanner();
    initSession(true);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.bridge === 'rpc') handleRpcMessage(msg.payload);
    else if (msg.bridge === 'agent_exit') onAgentExit(msg);
    else if (msg.bridge === 'agent_stderr' && msg.text.trim()) console.warn('[pi stderr]', msg.text);
  };
  ws.onclose = () => {
    setConn('off');
    showBanner('error', 'Connection to the bridge lost.', 'Retry now', () => connect());
  };
  ws.onerror = () => { /* onclose follows */ };
}

function send(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

function rpc(commandObj, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = `req-${++S.reqId}`;
    commandObj.id = id; // exposed so callers can correlate streamed events
    S.pending.set(id, { resolve, reject });
    send(commandObj);
    setTimeout(() => {
      if (S.pending.has(id)) {
        S.pending.delete(id);
        reject(new Error(`${commandObj.type}: timed out`));
      }
    }, timeoutMs);
  });
}

function handleRpcMessage(msg) {
  if (msg.type === 'response') {
    const p = S.pending.get(msg.id);
    if (p) {
      S.pending.delete(msg.id);
      msg.success ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'request failed'));
      if (!msg.success) toast(`Agent error (${msg.command}): ${msg.error}`, 'error');
    }
    return;
  }
  if (msg.type === 'extension_ui_request') { handleExtensionUi(msg); return; }
  handleEvent(msg);
}

function onAgentExit(msg) {
  S.isStreaming = false;
  setConn('on');
  if (msg.error) {
    showBanner('error', msg.error, 'Retry', () => send({ bridge: 'restart' }));
  } else {
    showBanner('warn', `Agent process exited${msg.code !== undefined ? ` (code ${msg.code})` : ''}.`,
      'Restart agent', () => send({ bridge: 'restart' }));
  }
}

async function initSession(resumeLast) {
  try {
    await rpc({ type: 'get_state' }).then((d) => applyState(d));
    if (resumeLast) await resumeLastSession();
    await refreshModels();
    await refreshLevels();
    await refreshCommands();
    await refreshBuiltinCommands();
    await refreshMessages();
    await refreshForkable();
    await refreshSessions();
    await refreshStats();
    S.initialized = true;
  } catch (e) {
    console.error('init failed', e);
    toast(`Init failed: ${e.message}`, 'error');
  }
}

/* A fresh pi process always starts a new empty session; on page load, reopen
 * the most recent session instead so work continues where it left off. */
async function resumeLastSession() {
  try {
    const res = await fetch('/api/sessions');
    const d = await res.json();
    const cur = S.state.sessionFile;
    const known = cur && d.sessions.some((s) => s.path === cur);
    if (!known && d.sessions.length && d.sessions[0].path !== cur) {
      await rpc({ type: 'switch_session', sessionPath: d.sessions[0].path });
      await rpc({ type: 'get_state' }).then((st) => applyState(st));
      toast(`Resumed last session: ${(d.sessions[0].name || 'unnamed').slice(0, 60)}`);
    }
  } catch { /* no sessions yet */ }
}

/* ───────────────────────── state / config refresh ───────────────────────── */

function applyState(d) {
  S.state = d || {};
  if (d) {
    if (d.sessionName) $('session-name').value = d.sessionName;
    else if (!$('session-name').value) $('session-name').value = '';
    // otherwise the derived session name (first user message) fills in via refreshSessions
    if (d.isStreaming !== undefined) S.isStreaming = d.isStreaming;
    if (d.model && d.model.id) syncSelect($('model-select'), `${d.model.provider}:${d.model.id}`);
    if (d.thinkingLevel) syncSelect($('thinking-select'), d.thinkingLevel);
    updateStreamUi();
  }
}

function syncSelect(sel, value) {
  if (value && [...sel.options].some((o) => o.value === value)) sel.value = value;
}

async function refreshModels() {
  try {
    const d = await rpc({ type: 'get_available_models' });
    S.models = asArray(d, 'models');
    const sel = $('model-select');
    sel.innerHTML = '';
    for (const m of S.models) {
      const o = el('option', null, `${m.name || m.id}`);
      o.value = `${m.provider}:${m.id}`;
      sel.appendChild(o);
    }
    if (S.state.model) syncSelect(sel, `${S.state.model.provider}:${S.state.model.id}`);
  } catch { /* agent may not implement it */ }
}

async function refreshLevels() {
  try {
    const d = await rpc({ type: 'get_available_thinking_levels' });
    S.levels = asArray(d, 'levels');
    const sel = $('thinking-select');
    sel.innerHTML = '';
    (S.levels.length ? S.levels : ['off']).forEach((lv) => {
      const o = el('option', null, `thinking: ${lv}`);
      o.value = lv;
      sel.appendChild(o);
    });
    if (S.state.thinkingLevel) syncSelect(sel, S.state.thinkingLevel);
  } catch { /* ignore */ }
}

async function refreshCommands() {
  try {
    const d = await rpc({ type: 'get_commands' });
    S.commands = asArray(d, 'commands');
  } catch { S.commands = []; }
}

/* Built-in slash commands (like /compact, /new) aren't returned by the agent's
 * get_commands RPC — the bridge reads them from the installed pi package so the
 * menu stays current automatically as pi adds commands. */
async function refreshBuiltinCommands() {
  try {
    const d = await fetch('/api/builtin-commands').then((r) => r.json());
    S.builtinCommands = Array.isArray(d.commands) ? d.commands : [];
  } catch { S.builtinCommands = []; }
}

async function refreshForkable() {
  try {
    const d = await rpc({ type: 'get_fork_messages' });
    S.forkable = asArray(d, 'messages');
  } catch { S.forkable = []; }
}

async function refreshStats() {
  try {
    const d = await rpc({ type: 'get_session_stats' });
    const cost = d && d.cost && d.cost.total != null ? Number(d.cost.total) : null;
    $('stat-cost').textContent = cost != null
      ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`
      : '';
    setCtxRing(d && d.contextUsage);
  } catch { /* ignore */ }
  updateTotals();
}

/* context-usage progress ring + "[used/max]ctx" label.
 * cu = { tokens, contextWindow, percent } from get_session_stats. After a
 * compaction the agent reports tokens:null until the next LLM response, in
 * which case the ring and label show a dash instead of a stale number. */
function setCtxRing(cu) {
  const fg = $('ctx-ring-fg');
  const txt = $('ctx-ring-text');
  const label = $('ctx-label');
  const wrap = fg.closest('.ctx-ring');
  const C = 2 * Math.PI * parseFloat(fg.getAttribute('r'));
  const tokens = cu && cu.tokens;
  const max = cu && cu.contextWindow;
  if (tokens == null || !max) {
    // Unknown or just compacted: dash + empty ring.
    txt.textContent = '–';
    fg.setAttribute('stroke-dasharray', '0 999');
    wrap.title = 'Context unknown — waiting for the next response';
    wrap.classList.remove('warn');
    if (label) label.textContent = '–';
    return;
  }
  const p = cu.percent != null
    ? Math.max(0, Math.min(100, cu.percent))
    : Math.max(0, Math.min(100, (tokens / max) * 100));
  fg.setAttribute('stroke-dasharray', `${(C * p / 100).toFixed(1)} ${C.toFixed(1)}`);
  txt.textContent = p >= 10 ? String(Math.round(p)) : p.toFixed(1);
  wrap.title = `Context: ${Math.round(tokens)} / ${Math.round(max)} tokens (${p.toFixed(1)}%)`;
  wrap.classList.toggle('warn', p > 75);
  if (label) label.textContent = `[${Math.round(tokens)}/${Math.round(max)}ctx]`;
}

/* session totals (↑ read / ↓ write) summed from assistant message usage */
function updateTotals(extraUsage) {
  const read = S.totals.read + ((u) => u ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0)(extraUsage);
  const write = S.totals.write + (extraUsage ? (extraUsage.output || 0) : 0);
  $('stat-tokens').textContent = `↑ ${formatTok(read) ?? 0} · ↓ ${formatTok(write) ?? 0}`;
}

/* ───────────────────────── chat rendering ───────────────────────── */

function scrollBottom(force) {
  if (force || S.stickToBottom) chat.scrollTop = chat.scrollHeight;
}
chat.addEventListener('scroll', () => {
  S.stickToBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
});

function messageBlock(content) {
  // user message content may be a string or a block array
  if (typeof content === 'string') return { text: content, images: [] };
  const blocks = Array.isArray(content) ? content : [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    images: blocks.filter((b) => b.type === 'image'),
  };
}

function makeMsgShell(role, who) {
  const root = el('div', `msg ${role}`);
  const head = el('div', 'who');
  if (role.includes('assistant')) {
    if (SET.avatar) {
      const av = el('img', 'avatar');
      av.src = SET.avatar;
      head.appendChild(av);
    }
    head.appendChild(el('span', 'agent-name-label', SET.agentName || 'pi'));
    head.appendChild(document.createTextNode(` · ${who}`));
  } else {
    head.appendChild(document.createTextNode(who));
  }
  const tools = el('span', 'msg-tools');
  head.appendChild(tools);
  const bubble = el('div', 'bubble');
  root.append(head, bubble);
  return { root, head, tools, bubble };
}

function addToolButton(container, label, title, fn) {
  const b = el('button', 'btn', label);
  b.title = title;
  b.onclick = fn;
  container.appendChild(b);
  return b;
}

function addCopyButton(tools, getText) {
  addToolButton(tools, 'copy', 'Copy text', () => {
    navigator.clipboard.writeText(getText()).then(() => toast('Copied'));
  });
}

function addSpeakButton(tools, getText) {
  addToolButton(tools, 'speak', 'Speak this message (TTS)', () => speak(getText()));
}

function renderUserMessage(msg) {
  const { text, images } = messageBlock(msg.content);
  const { root, tools, bubble } = makeMsgShell('user', `you · ${timeStr(msg.timestamp)}`);
  addCopyButton(tools, () => text);
  // fork index is (re)written onto the element by refreshMessages; read it at click time
  addToolButton(tools, 'edit', 'Edit & resend (forks the session from here)',
    () => startEdit(msg, root.dataset.forkIdx));

  if (images.length) {
    for (const im of images) {
      const img = el('img', 'msg-img');
      img.src = `data:${im.mimeType || 'image/png'};base64,${im.data}`;
      img.onclick = () => zoomImage(img.src);
      bubble.appendChild(img);
    }
  }
  if (text) {
    const body = el('div', 'md');
    body.innerHTML = renderMarkdown(text).replace(/^<p>/, '').replace(/<\/p>$/, '');
    bubble.appendChild(body);
  }
  chat.appendChild(root);
  scrollBottom();
}

function renderAssistantMessage(msg, timing) {
  const { root, tools, bubble } = makeMsgShell('assistant', timeStr(msg.timestamp));
  const textBlocks = [];
  const stats = usageStats(msg.usage, timing && timing.elapsedSec, timing && timing.prefillSec);
  if (stats) {
    const s = el('span', 'agent-stats', ` (${stats})`);
    s.title = 'token usage: input+cache read / output written' +
      (timing && timing.elapsedSec ? ` over ${timing.elapsedSec.toFixed(1)}s of streaming` : '');
    root.querySelector('.who').append(s);
  }
  addCopyButton(tools, () => textBlocks.join('\n\n'));
  addSpeakButton(tools, () => stripMarkdown(textBlocks.join('\n\n')));

  for (const block of msg.content || []) {
    if (block.type === 'text') {
      textBlocks.push(block.text);
      const d = el('div', 'md');
      d.innerHTML = renderMarkdown(block.text);
      bubble.appendChild(d);
    } else if (block.type === 'thinking') {
      bubble.appendChild(makeThinking(block.thinking || ''));
    } else if (block.type === 'toolCall') {
      const card = makeToolCard(block.name, { toolCallId: block.id });
      fillToolBody(card, block.name, block.arguments);
      bubble.appendChild(card.card);
      S.toolCards.set(block.id, card);
    }
  }
  if (!bubble.childNodes.length) bubble.appendChild(el('div', 'md', '(empty message)'));
  chat.appendChild(root);
  scrollBottom();
}

function makeThinking(text) {
  const d = el('details', 'thinking');
  d.open = SET.autoExpandThinking === true;
  d.appendChild(el('summary', null, 'thinking'));
  const body = el('div', 'th-body', text);
  d.appendChild(body);
  return d;
}

function makeToolCard(name, opts = {}) {
  const card = el('div', `tool-card${name === 'bash' ? ' bash-card' : ''}`);
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'tool-name', `${name}`));
  const stateEl = el('span', 'tool-state', opts.state || 'running…');
  head.appendChild(stateEl);
  const body = el('div', 'tool-body hidden');
  head.onclick = () => body.classList.toggle('hidden');
  card.append(head, body);
  return { card, head, body, stateEl };
}

/* Edit-style tool calls (old text -> new text) render as a color diff. */
function editArgsPairs(args) {
  if (!args || typeof args !== 'object') return [];
  const lower = {};
  for (const k of Object.keys(args)) lower[k.toLowerCase()] = args[k];
  const out = [];
  if (Array.isArray(lower.edits)) {
    for (const e of lower.edits) {
      if (!e || typeof e !== 'object') continue;
      const o = e.oldText ?? e.old ?? e.oldStr ?? e.old_string;
      const n = e.newText ?? e.new ?? e.newStr ?? e.new_string;
      if (typeof o === 'string' || typeof n === 'string') out.push([o ?? '', n ?? '']);
    }
    return out;
  }
  let oldV = null, newV = null;
  for (const k of ['oldstr', 'oldtext', 'old_string', 'search', 'find']) {
    if (k in lower && typeof lower[k] === 'string') { oldV = lower[k]; break; }
  }
  for (const k of ['newstr', 'newtext', 'new_string', 'replace']) {
    if (k in lower && typeof lower[k] === 'string') { newV = lower[k]; break; }
  }
  if (oldV != null || newV != null) out.push([oldV ?? '', newV ?? '']);
  return out;
}


function lineDiff(a, b) {
  const A = (a || '').split('\n');
  const B = (b || '').split('\n');
  const N = A.length, M = B.length;
  if (N * M > 400000) {
    return [...A.map((s) => ({ t: 'del', s })), ...B.map((s) => ({ t: 'add', s }))];
  }
  const dp = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (A[i] === B[j]) { out.push({ t: 'same', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: A[i++] }); }
    else { out.push({ t: 'add', s: B[j++] }); }
  }
  while (i < N) out.push({ t: 'del', s: A[i++] });
  while (j < M) out.push({ t: 'add', s: B[j++] });
  return out;
}

/* Fill a tool card body: diff for edits, pretty JSON otherwise. Diff bodies
 * are shown automatically since the diff is the interesting part. */
function fillToolBody(card, name, args) {
  const filePath = args && typeof args === 'object'
    ? (args.path || args.file || args.file_path || args.filePath || '') : '';
  const lowerArgs = {};
  if (args && typeof args === 'object') for (const k of Object.keys(args)) lowerArgs[k.toLowerCase()] = args[k];
  const pairs = editArgsPairs(args);
  if (pairs.length) {
    card.body.innerHTML = '';
    const box = el('div', 'diffbox');
    let adds = 0, dels = 0;
    const header = (label, a, d) => {
      const h = el('div', 'diff-file');
      h.appendChild(el('span', null, label));
      const cnt = el('span', 'diff-count');
      const plus = el('span', 'c-add', `+${a}`);
      const minus = el('span', 'c-del', ` −${d}`);
      cnt.append(plus, minus);
      h.appendChild(cnt);
      box.appendChild(h);
    };
    pairs.forEach(([o, nn], idx) => {
      const lines = lineDiff(o, nn);
      const a = lines.filter((l) => l.t === 'add').length;
      const d = lines.filter((l) => l.t === 'del').length;
      adds += a; dels += d;
      header(idx === 0 ? filePath : '…', a, d);
      for (const { t, s } of lines) {
        box.appendChild(el('div', `dl ${t}`, s));
      }
    });
    if (pairs.length > 1) header('total', adds, dels);
    card.body.appendChild(box);
    card.body.classList.remove('hidden');
  } else if (args !== undefined) {
    card.body.innerHTML = '';
    const box = el('div', 'diffbox');
    if (filePath) box.appendChild(el('div', 'diff-file', filePath));
    const pre = el('div', 'dl');
    pre.textContent = typeof lowerArgs.content === 'string'
      ? lowerArgs.content
      : JSON.stringify(args, null, 2);
    box.appendChild(pre);
    card.body.appendChild(box);
    card.body.classList.remove('hidden');
  }
}

function renderToolResult(msg) {
  const card = S.toolCards.get(msg.toolCallId);
  const bodyText = toolResultText(msg);
  if (card) {
    // keep a rendered edit diff — the result line adds nothing to it
    if (!card.body.querySelector('.diffbox')) card.body.textContent = bodyText;
    card.stateEl.textContent = msg.isError ? 'error' : 'done';
    card.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
    if (!card.body.textContent && !card.body.firstChild) card.body.classList.add('hidden');
  } else {
    const { root, bubble } = makeMsgShell('tool', `${msg.toolName || 'tool'} result · ${timeStr(msg.timestamp)}`);
    const c = makeToolCard(msg.toolName || 'tool', { state: msg.isError ? 'error' : 'done' });
    c.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
    c.body.textContent = bodyText;
    c.body.classList.remove('hidden');
    bubble.appendChild(c.card);
    root.querySelector('.who').remove();
    chat.appendChild(root);
    scrollBottom();
  }
}

function toolResultText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return `[image ${b.mimeType || ''}]`;
      return JSON.stringify(b);
    }).join('\n');
  }
  return c ? JSON.stringify(c, null, 2) : '';
}

/* Console/shell output renders as a plain "system" text box. */
function renderBashExecution(msg) {
  const { root, bubble } = makeMsgShell('system', `system · ${timeStr(msg.timestamp)}`);
  root.querySelector('.who').remove();
  bubble.textContent = `$ ${msg.command}\n${msg.output || '(no output)'}`;
  chat.appendChild(root);
  scrollBottom();
}

/* The compaction summary message (role: "compactionSummary") marks where the old
 * history was compressed into a summary. The terminal shows this as a blue block;
 * the web ui previously dropped it (no case for this role), so the compacted
 * marker was invisible. Render it as a compact, collapsible "compacted" block. */
function renderCompactionSummary(msg) {
  const root = el('div', 'msg compaction');
  const who = el('div', 'who');
  const before = msg.tokensBefore != null ? `· ${Math.round(msg.tokensBefore).toLocaleString()} tok → summary` : '';
  who.textContent = `compacted ${before}`;
  const detail = el('details', 'compaction-detail');
  detail.appendChild(el('summary', null, 'show compacted summary'));
  const body = el('div', 'md compaction-body');
  body.innerHTML = renderMarkdown(msg.summary || '');
  detail.appendChild(body);
  root.append(who, detail);
  chat.appendChild(root);
}

async function refreshMessages() {
  const d = await rpc({ type: 'get_messages' });
  const msgs = asArray(d, 'messages');
  chat.innerHTML = '';
  S.toolCards.clear();
  // session token totals summed from per-message usage
  let read = 0, write = 0;
  for (const m of msgs) {
    if (m.role === 'user') renderUserMessage(m);
    else if (m.role === 'assistant') {
      renderAssistantMessage(m);
      if (m.usage) {
        read += (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
        write += m.usage.output || 0;
      }
    }
    else if (m.role === 'toolResult') renderToolResult(m);
    else if (m.role === 'bashExecution') renderBashExecution(m);
    else if (m.role === 'compactionSummary') renderCompactionSummary(m);
  }
  S.totals = { read, write };
  updateTotals();
  // Re-wire fork indexes for user messages in order.
  const userEls = [...chat.querySelectorAll('.msg.user')];
  userEls.forEach((e, i) => e.dataset.forkIdx = String(i));
  scrollBottom(true);
}

function zoomImage(src) {
  const ov = el('div', 'drop-overlay');
  ov.style.background = 'rgba(0,0,0,.85)';
  const img = el('img');
  img.src = src;
  img.style.maxHeight = '90vh';
  img.style.maxWidth = '90vw';
  ov.appendChild(img);
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}

/* ───────────────────────── event stream ───────────────────────── */

function handleEvent(msg) {
  switch (msg.type) {
    case 'agent_start':
      S.isStreaming = true;
      updateStreamUi();
      break;
    case 'agent_end':
    case 'agent_settled':
      if (msg.type === 'agent_settled') S.isStreaming = false;
      updateStreamUi();
      if (msg.type === 'agent_end') {
        finalizeLive();
        refreshCommands().catch(() => {});   // extensions may register commands late
        refreshStats().catch(() => {});
        refreshForkable().catch(() => {});
        refreshSessions().catch(() => {});
      }
      // Send the next message the user queued during compaction, now that the
      // agent is idle (agent_settled). No-op when the queue is empty.
      flushCompactionQueue();
      break;
    case 'message_start':
      startLive();
      break;
    case 'message_update':
      if (msg.usage && S.live) S.live.lastUsage = msg.usage;
      applyDelta(msg.assistantMessageEvent || {});
      break;
    case 'message_end':
      finalizeLive(msg.message);
      break;
    case 'turn_end':
      finalizeLive();
      break;
    case 'tool_execution_start':
      startToolCard(msg);
      break;
    case 'tool_execution_update': {
      const c = S.toolCards.get(msg.toolCallId);
      if (c && msg.partialResult !== undefined) {
        c.body.textContent = toolResultText({ content: msg.partialResult });
        c.body.classList.remove('hidden');
      }
      break;
    }
    case 'tool_execution_end': {
      const c = S.toolCards.get(msg.toolCallId);
      if (c) {
        if (msg.result !== undefined && !c.body.querySelector('.diffbox')) c.body.textContent = toolResultText({ content: msg.result });
        c.stateEl.textContent = msg.isError ? 'error' : 'done';
        c.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
      }
      break;
    }
    case 'bash_execution_update': {
      const c = S.bashCards.get(msg.id);
      if (c) { c.body.textContent += msg.delta || ''; c.body.classList.remove('hidden'); scrollBottom(); }
      break;
    }
    case 'queue_update':
      S.queue = { steering: msg.steering || [], followUp: msg.followUp || [] };
      renderQueue();
      break;
    case 'extension_error':
      toast(`Extension error: ${msg.error}`, 'error');
      break;
    case 'auto_retry_start':
      toast(`Retrying (${msg.attempt}/${msg.maxAttempts}) in ${Math.round((msg.delayMs || 0) / 1000)}s: ${msg.errorMessage}`, 'warning');
      break;
    case 'compaction_start':
      S.compacting = true;
      toast('Compacting session…');
      // The pre-compaction token count is now stale; show a dash until the
      // next LLM response reports a real post-compaction context size.
      setCtxRing(null);
      if ($('ctx-label')) $('ctx-label').textContent = 'compacting…';
      break;
    case 'compaction_end':
      S.compacting = false;
      if (msg.aborted) {
        toast('Compaction cancelled', 'warning');
      } else if (msg.errorMessage) {
        toast(msg.errorMessage, 'error');
      } else if (msg.result) {
        const before = msg.result.tokensBefore;
        const after = msg.result.estimatedTokensAfter;
        toast(`Compacted: ${before != null ? Math.round(before) : '?'} → ${after != null ? Math.round(after) : '?'} tokens`);
      }
      // Context is unknown right after compaction (agent reports tokens:null
      // until the next response) — refresh to reflect that, then send any
      // messages the user queued while compaction was running.
      refreshStats().catch(() => {});
      flushCompactionQueue();
      break;
    default:
      break;
  }
}

/* live streaming render */
function startLive() {
  const { root, tools, bubble } = makeMsgShell('assistant streaming', '…');
  addCopyButton(tools, () => S.live ? S.live.text : '');
  addSpeakButton(tools, () => stripMarkdown(S.live ? S.live.text : ''));
  const md = el('div', 'md');
  bubble.appendChild(md);
  const statsEl = el('span', 'agent-stats');
  root.querySelector('.who').appendChild(statsEl);
  chat.appendChild(root);
  S.live = { root, md, text: '', thinking: '', thinkingEl: null, caret: el('span', 'streaming-caret'),
             startTs: Date.now(), lastUsage: null, statsEl };
  scrollBottom();
}

function applyDelta(ev) {
  if (!S.live) startLive();
  const L = S.live;
  if (ev.type === 'text_delta') { if (!L.firstDeltaTs) L.firstDeltaTs = Date.now(); L.text += ev.delta || ''; }
  else if (ev.type === 'text_start') { /* noop */ }
  else if (ev.type === 'text_end') { /* noop */ }
  else if (ev.type === 'thinking_delta') { if (!L.firstDeltaTs) L.firstDeltaTs = Date.now(); L.thinking += ev.delta || ''; }
  else if (ev.type === 'toolcall_start' && ev.id) {
    startToolCard({ toolCallId: ev.id, toolName: ev.toolName });
  }
  else if (ev.type === 'toolcall_delta' && ev.id) {
    // stream partial tool arguments so "write" shows the file as it is written
    const c = S.toolCards.get(ev.id);
    if (c) {
      c._rawArgs = (c._rawArgs || '') + (ev.delta || ev.argumentsDelta || ev.partial || ev.partialArgs || '');
      c.body.classList.remove('hidden');
      c.body.textContent = liveToolPreview(c.toolName, c._rawArgs);
    }
  }
  else if (ev.type === 'toolcall_end' && ev.toolCall) {
    const card = makeToolCard(ev.toolCall.name, { toolCallId: ev.toolCall.id });
    fillToolBody(card, ev.toolCall.name, ev.toolCall.arguments);
    L.root.querySelector('.bubble').appendChild(card.card);
    S.toolCards.set(ev.toolCall.id, card);
  }
  renderLive();
}

/* Live preview while a tool call's arguments stream in: for write-like tools
 * show the decoded file content so far, otherwise the raw partial arguments. */
function liveToolPreview(name, raw) {
  if (/write|edit/i.test(name || '')) {
    const m = raw.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)/);
    if (m) {
      return m[1]
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        .slice(-4000);
    }
  }
  return raw.slice(-2000);
}

let liveRaf = null;
function renderLive() {
  if (liveRaf || !S.live) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = null;
    if (!S.live) return;
    const L = S.live;
    if (L.thinking && !L.thinkingEl) {
      L.thinkingEl = makeThinking('');
      L.md.before(L.thinkingEl);
    }
    if (L.thinkingEl) L.thinkingEl.querySelector('.th-body').textContent = L.thinking;
    L.md.innerHTML = renderMarkdown(L.text);
    if (!L.text) L.md.appendChild(el('span', 'streaming-caret'));
    // live token counter, updated as tokens stream in. Until the provider
    // reports usage, estimate written tokens from streamed characters.
    const sec = (Date.now() - L.startTs) / 1000;
    const prefill = L.firstDeltaTs ? (L.firstDeltaTs - L.startTs) / 1000 : null;
    let stats;
    if (L.lastUsage) {
      stats = usageStats(L.lastUsage, sec, prefill);
    } else {
      const est = Math.round((L.text.length + L.thinking.length) / 4);
      stats = est ? `↓ ~${formatTok(est) || 0} write` +
        (sec > 0.2 ? ` @ ${(est / sec).toFixed(1)} t/s` : '') : '';
    }
    if (stats) L.statsEl.textContent = ` (${stats})`;
    scrollBottom();
  });
}

function finalizeLive(finalMsg) {
  if (S.live) {
    const L = S.live;
    const elapsedSec = (Date.now() - L.startTs) / 1000;
    const prefillSec = L.firstDeltaTs ? (L.firstDeltaTs - L.startTs) / 1000 : null;
    S.live.root.remove();
    S.live = null;
    if (finalMsg && finalMsg.role === 'assistant') {
      const usage = finalMsg.usage || L.lastUsage;
      if (usage) {
        S.totals.read += (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
        S.totals.write += usage.output || 0;
      }
      renderAssistantMessage(usage && !finalMsg.usage ? { ...finalMsg, usage } : finalMsg,
        { elapsedSec, prefillSec });
      updateTotals();
      if (S.autoTts) {
        const text = (finalMsg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        if (text.trim()) speak(stripMarkdown(text));
      }
    } else {
      refreshMessages().catch(() => {});
    }
  }
  S.isStreaming = false;
  updateStreamUi();
}

function startToolCard(msg) {
  const existing = msg.toolCallId && S.toolCards.get(msg.toolCallId);
  if (existing) {
    // already created by a streaming toolcall_start — just fill in the name
    if (msg.toolName && !existing.toolName) {
      existing.toolName = msg.toolName;
      existing.card.querySelector('.tool-name').textContent = msg.toolName;
    }
    return existing;
  }
  const card = makeToolCard(msg.toolName || msg.name || 'tool', { toolCallId: msg.toolCallId });
  card.toolName = msg.toolName || msg.name || '';
  card._rawArgs = '';
  fillToolBody(card, card.toolName, msg.args);
  const parent = S.live ? S.live.root.querySelector('.bubble') : chat;
  parent.appendChild(card.card);
  S.toolCards.set(msg.toolCallId, card);
  scrollBottom();
  return card;
}

function updateStreamUi() {
  // The Stop button appears next to the (always visible) Send button while the
  // agent is generating, so you can stop generation or steer/queue a message.
  $('btn-stop').classList.toggle('hidden', !S.isStreaming);
  setConn(S.isStreaming ? 'busy' : 'on');
  if (S.isStreaming) startCtxPoll(); else stopCtxPoll();
  renderQueue();
}

/* Live context ring: while the agent is streaming, poll session stats so the
 * ring and the [used/max]ctx label track context growth in real time instead
 * of only updating when switching sessions. */
let ctxPollTimer = null;
function startCtxPoll() {
  if (ctxPollTimer) return;
  refreshStats().catch(() => {});
  ctxPollTimer = setInterval(() => {
    if (S.isStreaming) refreshStats().catch(() => {}); else stopCtxPoll();
  }, 1000);
}
function stopCtxPoll() {
  if (ctxPollTimer) { clearInterval(ctxPollTimer); ctxPollTimer = null; }
}

/* While compaction is running the agent rejects new prompts, so messages the
 * user typed are held here and sent (one at a time) once the agent is idle
 * again. flushCompactionQueue() is called on compaction_end and agent_end. */
function flushCompactionQueue() {
  if (!S.compactionQueue.length) return;
  if (S.isStreaming || S.compacting) return; // wait until the agent is idle
  const next = S.compactionQueue.shift();
  sendPrompt(next.text, next.images);
  // The next agent_end/agent_settled will flush the rest of the queue.
}

function renderQueue() {
  const bar = $('queue-bar');
  const items = [...S.queue.steering, ...S.queue.followUp];
  if (!items.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  bar.appendChild(el('span', null, 'queued: '));
  for (const q of items) {
    const chip = el('span', 'queue-chip', (typeof q.message === 'string' ? q.message : JSON.stringify(q.message || q)).slice(0, 120));
    bar.appendChild(chip);
  }
}

/* ───────────────────────── composer / sending ───────────────────────── */

const input = $('input');

function autoSize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
input.addEventListener('input', () => { autoSize(); updateSlashMenu(); });

async function sendCurrent() {
  const text = input.value.trim();
  if (S.editMode) {
    if (!text) return;
    finishEdit(text);
    return;
  }
  if (!text && !S.attachments.length) return;

  if (text.startsWith('!') && text.length > 1) {
    sendBash(text.slice(1).trim());
    resetComposer();
    return;
  }

  // While compaction is in flight the agent rejects new prompts. Hold the
  // message locally and send it once compaction finishes — don't lose it.
  if (S.compacting && !text.startsWith('/')) {
    S.compactionQueue.push({ text, images: S.attachments.slice() });
    toast(`Compaction in progress — queued your message (will send when it's done)`, 'info');
    resetComposer();
    return;
  }

  if (text.startsWith('/')) {
    const sp = text.indexOf(' ');
    const name = (sp >= 0 ? text.slice(1, sp) : text.slice(1)).toLowerCase();
    const arg = sp >= 0 ? text.slice(sp + 1).trim() : '';

    // Client-local slash commands: executed by the UI, never sent to the agent.
    if (name === 'tts') { setAutoTts(!S.autoTts); resetComposer(); return; }
    if (name === 'autosend') {
      SET.voiceAutoSend = !SET.voiceAutoSend;
      saveSettings();
      toast(`Voice auto-send ${SET.voiceAutoSend ? 'ON — voice results send automatically' : 'OFF'}`);
      resetComposer();
      return;
    }
    if (name === 'thinking' && !arg) {
      // /thinking (no arg) toggles thinking-block visibility. /thinking <level>
      // (with an arg) falls through to the built-in set-thinking-level command.
      SET.showThinking = !(SET.showThinking !== false);
      saveSettings();
      toast(`Thinking blocks ${SET.showThinking !== false ? 'visible' : 'hidden'}`);
      resetComposer();
      return;
    }

    // Built-in pi commands that map to a direct RPC call (e.g. /compact, /new).
    const handled = await handleBuiltinCommand(name, arg);
    if (handled) { resetComposer(); return; }

    // Only warn for commands not in any known list (local, agent, or pi built-in).
    const known = allCommands().find((c) => c.name.toLowerCase() === name || c.name.toLowerCase() === `skill:${name}`);
    if (!known) {
      toast(`"/${name}" is not a registered agent or UI command — sending to the model as text`, 'warning');
    }
  }

  sendPrompt(text, S.attachments.slice());
  resetComposer();
}

/* Built-in pi slash commands that have a direct RPC equivalent. Returns true
 * if the command was handled by the UI (don't send to the agent); false means
 * "send it to the agent as a normal prompt". Commands without a clean RPC
 * mapping (e.g. /tree, /settings, /fork) fall through to the agent. */
async function handleBuiltinCommand(name, arg) {
  // Agent-registered commands (extension/prompt/skill) take precedence over a
  // built-in with the same name — those are sent to the agent instead.
  if (S.commands.some((c) => c.name.toLowerCase() === name || c.name.toLowerCase() === `skill:${name}`)) {
    return false;
  }
  switch (name) {
    case 'compact': {
      if (S.compacting) { toast('Compaction already in progress…', 'warning'); return true; }
      S.compacting = true;
      toast('Compacting session…');
      setCtxRing(null);
      if ($('ctx-label')) $('ctx-label').textContent = 'compacting…';
      // Compaction makes an LLM call and can take minutes — the old 120s RPC
      // timeout fired first and reported a false failure while the agent kept
      // compacting. Don't block on the response; track progress via the
      // compaction_start / compaction_end events. The RPC promise is only a
      // backup for the case where those events never arrive.
      rpc({ type: 'compact' }, 10 * 60 * 1000)
        .catch((e) => {
          if (S.compacting) {
            S.compacting = false;
            toast(`Compact failed: ${e.message}`, 'error');
          }
        });
      return true;
    }
    case 'new': {
      try { await rpc({ type: 'new_session' }); await initSession(false); }
      catch (e) { toast(`New session failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'name': {
      if (!arg) { toast('Usage: /name <name>'); return true; }
      try { await rpc({ type: 'set_session_name', name: arg }); await refreshSessions(); }
      catch (e) { toast(`Rename failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'model': {
      const slash = arg.indexOf('/');
      if (slash <= 0) { toast('Usage: /model <provider/model>'); return true; }
      try {
        await rpc({ type: 'set_model', provider: arg.slice(0, slash), modelId: arg.slice(slash + 1) });
        const st = await rpc({ type: 'get_state' }); applyState(st);
      } catch (e) { toast(`Set model failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'thinking': {
      if (!arg) { toast('Usage: /thinking <level>'); return true; }
      try {
        await rpc({ type: 'set_thinking_level', level: arg.split(/\s+/)[0] });
        const st = await rpc({ type: 'get_state' }); applyState(st);
      } catch (e) { toast(`Set thinking failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'clone': {
      try { await rpc({ type: 'clone' }); await refreshSessions(); }
      catch (e) { toast(`Clone failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'copy': {
      try {
        const d = await rpc({ type: 'get_last_assistant_text' });
        if (d && d.text) { await navigator.clipboard.writeText(d.text); toast('Copied last assistant message'); }
        else toast('No assistant message to copy', 'warning');
      } catch (e) { toast(`Copy failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'session': {
      await refreshStats();
      try {
        const d = await rpc({ type: 'get_session_stats' });
        const cu = d && d.contextUsage;
        const toks = cu && cu.tokens != null ? `${Math.round(cu.tokens)}/${Math.round(cu.contextWindow)}` : '–';
        const cost = d && d.cost && d.cost.total != null ? `$${Number(d.cost.total).toFixed(3)}` : '–';
        toast(`Session: ${S.sessionName || '(unnamed)'} · context ${toks} · cost ${cost}`);
      } catch { /* ignore */ }
      return true;
    }
    default:
      return false; // not handled here — send to the agent as a prompt
  }
}

function sendPrompt(text, images, behavior) {
  const cmd = { type: 'prompt', message: text };
  if (images && images.length) {
    cmd.images = images.map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType }));
  }
  if (S.isStreaming) cmd.streamingBehavior = behavior || 'steer';
  rpc(cmd).catch((e) => toast(e.message, 'error'));
  // Optimistic bubble; replaced by the authoritative history on the next agent_end.
  if (text || (images && images.length)) {
    renderUserMessage({ role: 'user', content: images && images.length
      ? [...images.map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType })), { type: 'text', text }]
      : text, timestamp: Date.now() });
    S.stickToBottom = true;
    scrollBottom(true);
  }
}

async function sendBash(command) {
  const { root, bubble } = makeMsgShell('system', `system · ${timeStr()}`);
  root.querySelector('.who').remove();
  const out = el('div', null, `$ ${command}\n`);
  bubble.appendChild(out);
  chat.appendChild(root);
  scrollBottom(true);
  try {
    const cmd = { type: 'bash', command };
    S.bashCards.set(cmd.id, { body: out });
    const d = await rpc(cmd);
    S.bashCards.delete(cmd.id);
    out.textContent = `$ ${command}\n${(d && d.output) || '(no output)'}`;
    if (d && d.exitCode) toast(`Command exited with code ${d.exitCode}`, 'warning');
  } catch (e) {
    out.textContent += `\n[error] ${e.message}`;
  }
}

function resetComposer() {
  input.value = '';
  autoSize();
  clearAttachments();
  closeSlashMenu();
  updateEditBanner();
  input.focus();
}

$('btn-send').onclick = sendCurrent;
$('btn-stop').onclick = stopAgent;

async function stopAgent() {
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); S.speaking = false; return; }
  try {
    const d = await rpc({ type: 'clear_queue' });
    const restored = [...((d && d.steering) || []), ...((d && d.followUp) || [])]
      .map((m) => (typeof m.message === 'string' ? m.message : ''))
      .filter(Boolean);
    if (restored.length) {
      input.value = restored.join('\n---\n') + (input.value ? '\n' + input.value : '');
      autoSize();
    }
    await rpc({ type: 'abort' });
    toast('Aborted');
  } catch (e) { toast(e.message, 'error'); }
}

/* ───────────────────────── edit & resend (fork) ───────────────────────── */

function startEdit(msg, forkIdx) {
  const { text } = messageBlock(msg.content);
  const idx = parseInt(forkIdx, 10);
  const f = S.forkable[idx] && S.forkable[idx].text === text
    ? S.forkable[idx]
    : S.forkable.find((x) => x.text === text);
  if (!f) { toast('Cannot locate a fork point for this message', 'error'); return; }
  S.editMode = { entryId: f.entryId, originalText: text };
  input.value = text;
  autoSize();
  updateEditBanner();
  input.focus();
}

function updateEditBanner() {
  const b = $('edit-banner');
  if (S.editMode) {
    b.classList.remove('hidden');
    $('edit-banner-text').textContent = `Editing an earlier message — sending will fork the session from that point. Original: "${S.editMode.originalText.slice(0, 60)}${S.editMode.originalText.length > 60 ? '…' : ''}"`;
  } else {
    b.classList.add('hidden');
  }
}

$('btn-cancel-edit').onclick = () => {
  S.editMode = null;
  input.value = '';
  autoSize();
  updateEditBanner();
};

async function finishEdit(newText) {
  const edit = S.editMode;
  S.editMode = null;
  updateEditBanner();
  try {
    await rpc({ type: 'fork', entryId: edit.entryId });
    await refreshMessages();
    await refreshForkable();
    sendPrompt(newText, S.attachments.slice());
    resetComposer();
  } catch (e) {
    toast(`Fork failed: ${e.message}`, 'error');
  }
}

/* ───────────────────────── attachments (upload / paste / drop) ───────────────────────── */

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function addImageFile(file) {
  if (!file.type.startsWith('image/')) { toast(`Not an image: ${file.name}`, 'warning'); return; }
  const dataUrl = await readAsDataUrl(file);
  S.attachments.push({
    data: dataUrl.split(',')[1],
    mimeType: file.type,
    name: file.name || 'pasted-image',
  });
  renderAttachments();
}

function renderAttachments() {
  const wrap = $('attachments');
  wrap.innerHTML = '';
  wrap.classList.toggle('hidden', !S.attachments.length);
  S.attachments.forEach((a, i) => {
    const box = el('div', 'attachment');
    const img = el('img');
    img.src = `data:${a.mimeType};base64,${a.data}`;
    img.title = a.name;
    const rm = el('button', 'rm', '×');
    rm.onclick = () => { S.attachments.splice(i, 1); renderAttachments(); };
    box.append(img, rm);
    wrap.appendChild(box);
  });
}

function clearAttachments() {
  S.attachments = [];
  renderAttachments();
}

$('btn-attach').onclick = () => $('file-input').click();
$('file-input').onchange = async (e) => {
  for (const f of e.target.files) await addImageFile(f);
  e.target.value = '';
};

// paste images from clipboard
document.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (!items.length) return;
  e.preventDefault();
  for (const item of items) {
    const file = item.getAsFile();
    if (file) addImageFile(file);
  }
  toast('Image pasted from clipboard');
});

// drag & drop images onto the window
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) {
    dragDepth++;
    $('drop-overlay').classList.remove('hidden');
  }
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.add('hidden'); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').classList.add('hidden');
  for (const f of e.dataTransfer?.files || []) await addImageFile(f);
});

/* ───────────────────────── slash commands ───────────────────────── */

/* handled by the UI itself, never sent to the agent */
const LOCAL_COMMANDS = [
  { name: 'tts', description: 'Toggle text-to-speech for agent replies', source: 'local' },
  { name: 'autosend', description: 'Toggle auto-send after voice input', source: 'local' },
  { name: 'thinking', description: 'Toggle showing thinking blocks', source: 'local' },
];

function allCommands() {
  const seen = new Set();
  const out = [];
  // Local UI commands take precedence, then agent (extension/prompt/skill)
  // commands, then pi's built-in slash commands. Deduped by name so e.g. the
  // local /thinking toggle isn't shadowed twice.
  for (const c of [...LOCAL_COMMANDS, ...S.commands, ...S.builtinCommands]) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

let slash = { open: false, items: [], sel: 0, menu: null };

function updateSlashMenu() {
  const v = input.value;
  const caretInFirstWord = !v.slice(input.selectionStart).includes(' ');
  const m = v.match(/^\/(\S*)$/);
  if (!m || !caretInFirstWord || !allCommands().length) { closeSlashMenu(); return; }
  const q = m[1].toLowerCase();
  const items = allCommands()
    .filter((c) => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))
    .slice(0, 12);
  if (!items.length) { closeSlashMenu(); return; }
  openSlashMenu(items);
}

function openSlashMenu(items) {
  closeSlashMenu();
  slash = { open: true, items, sel: 0, menu: null };
  const menu = el('div', 'slash-menu');
  items.forEach((c, i) => {
    const row = el('div', 'slash-item' + (i === 0 ? ' sel' : ''));
    row.appendChild(el('span', 'cmd', '/' + c.name));
    if (c.description) row.appendChild(el('span', 'desc', c.description));
    if (c.source) {
      const label = c.source === 'local' ? 'ui' : c.source === 'builtin' ? 'pi' : c.source;
      row.appendChild(el('span', `src ${c.source}`, label));
    }
    row.onclick = () => pickSlash(i);
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  const r = input.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.bottom = `${window.innerHeight - r.top + 8}px`;
  slash.menu = menu;
}

function closeSlashMenu() {
  if (slash.menu) slash.menu.remove();
  slash = { open: false, items: [], sel: 0, menu: null };
}

function moveSlashSel(d) {
  if (!slash.open) return;
  slash.sel = (slash.sel + d + slash.items.length) % slash.items.length;
  [...slash.menu.children].forEach((c, i) => c.classList.toggle('sel', i === slash.sel));
  slash.menu.children[slash.sel].scrollIntoView({ block: 'nearest' });
}

function pickSlash(i) {
  const c = slash.items[i];
  if (!c) return;
  input.value = '/' + c.name + ' ';
  input.focus();
  closeSlashMenu();
  autoSize();
}

/* ───────────────────────── keyboard ───────────────────────── */

input.addEventListener('keydown', (e) => {
  if (slash.open) {
    if (e.key === 'ArrowDown') { moveSlashSel(1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { moveSlashSel(-1); e.preventDefault(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { pickSlash(slash.sel); e.preventDefault(); return; }
    if (e.key === 'Escape') { closeSlashMenu(); e.preventDefault(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { sendCurrent(); e.preventDefault(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !slash.open && !$('ext-dialog').open) {
    if (S.speaking) { speechSynthesis.cancel(); S.speaking = false; $('btn-tts').classList.remove('on'); }
    else if (S.isStreaming) stopAgent();
  }
});

/* ───────────────────────── voice to text ───────────────────────── */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, recogBase = '', recogActive = false, recogAborted = false;

if (!SR) {
  $('btn-mic').title = 'Browser voice unavailable — configure a Whisper endpoint in settings for voice input';
} else {
  recog = new SR();
  recog.interimResults = true;
  recog.continuous = true; // keep listening until the mic is clicked again
  recog.lang = navigator.language || 'en-US';

  recog.onresult = (e) => {
    let finalText = '', interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    input.value = (recogBase + finalText + interim).replace(/\s+$/, ' ');
    autoSize();
  };
  recog.onend = () => {
    recogActive = false;
    $('btn-mic').classList.remove('recording');
    // Optional hands-free mode: send what was dictated once recognition ends.
    if (SET.voiceAutoSend && !recogAborted && input.value.trim()) sendCurrent();
  };
  recog.onerror = (e) => {
    recogActive = false;
    $('btn-mic').classList.remove('recording');
    if (e.error === 'not-allowed') toast('Microphone permission denied', 'error');
    else if (e.error === 'aborted') recogAborted = true;
    else if (e.error !== 'aborted') toast(`Voice input error: ${e.error}`, 'error');
  };
}

/* Whisper-compatible speech-to-text (whisper.cpp server /inference, or any
 * OpenAI-style /v1/audio/transcriptions). The recording is converted to
 * 16 kHz mono WAV in the browser first, so Firefox (ogg) and Chrome (webm)
 * both work. Falls back to browser SpeechRecognition without an endpoint. */
async function blobToWav(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf);
  const src = decoded.getChannelData(0);
  const rate = 16000;
  // whisper.cpp rejects very short clips - pad to at least 1.2 s of audio
  const minSamples = Math.ceil(1.2 * rate);
  const outLen = Math.max(minSamples, Math.ceil(src.length * rate / decoded.sampleRate));
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = src[Math.min(src.length - 1, Math.floor(i * decoded.sampleRate / rate))];
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  ctx.close();
  const wav = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(wav);
  const wstr = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(wav, 44).set(pcm);
  return new Blob([wav], { type: 'audio/wav' });
}

async function transcribeWithWhisper(blob) {
  const wav = await blobToWav(blob);
  const isOpenAI = /\/v1\/audio\/transcriptions\/?$/.test(SET.sttEndpoint);
  const fd = new FormData();
  if (isOpenAI) {
    fd.append('file', wav, 'speech.wav');
    fd.append('model', 'whisper-1');
    fd.append('response_format', 'json');
  } else {
    // whisper.cpp server's /inference reads the audio from the multipart
    // field named "file" (NOT "audio_file"). Any 400 it returns is
    // overwritten by its error handler with the generic "Invalid request",
    // so a wrong field name surfaces as that cryptic message.
    fd.append('file', wav, 'speech.wav');
    fd.append('response_format', 'json');
  }
  const res = await fetch(SET.sttEndpoint, { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 120); } catch { /* ignore */ }
    throw new Error(`STT server ${res.status} ${detail}`);
  }
  const d = await res.json();
  return d.text || d.transcription || '';
}

let mediaRecorder = null, mediaStream = null, recAudioChunks = [], whisperBusy = false;

async function startWhisperRecording() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recAudioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recAudioChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    mediaStream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(recAudioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    void blob;
    $('btn-mic').classList.remove('recording');
    if (blob.size < 800) return; // just a click
    whisperBusy = true;
    $('btn-mic').classList.add('recording'); // stays lit while transcribing
    try {
      const text = await transcribeWithWhisper(blob);
      if (text) {
        input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + text.trim();
        autoSize();
        if (SET.voiceAutoSend) sendCurrent();
      } else toast('Whisper heard nothing');
    } catch (e) {
      toast(`Whisper failed: ${e.message}`, 'error');
    } finally {
      whisperBusy = false;
      $('btn-mic').classList.remove('recording');
    }
  };
  mediaRecorder.start();
  $('btn-mic').classList.add('recording');
  toast('Recording… click again to transcribe with Whisper');
}

async function ensureSttEndpoint() {
  if (SET.sttEndpoint) return;
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    if (cfg.whisperUrl) {
      SET.sttEndpoint = cfg.whisperUrl;
      saveSettings();
      toast('Using local whisper server for voice input');
    }
  } catch { /* no endpoint */ }
}

$('btn-mic').onclick = async () => {
  if (whisperBusy) return;
  const useWhisper = (SET.sttBackend || 'whisper') !== 'browser';
  if (useWhisper && !SET.sttEndpoint) await ensureSttEndpoint();
  if (useWhisper && SET.sttEndpoint) {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    startWhisperRecording().catch((e) => {
      $('btn-mic').classList.remove('recording');
      toast(`Microphone error: ${e.message}`, 'error');
    });
    return;
  }
  // browser SpeechRecognition fallback
  if (!recog) { toast('This browser has no built-in voice — set a Whisper endpoint in settings (⚙) for voice input', 'warning'); return; }
  if (recogActive) { recogAborted = true; recog.stop(); return; }
  recogBase = input.value ? input.value.replace(/\s+$/, '') + ' ' : '';
  recogAborted = false;
  try {
    recog.start();
    recogActive = true;
    $('btn-mic').classList.add('recording');
    if (SET.voiceAutoSend) toast('Listening… will auto-send when you stop talking');
  } catch { /* already started */ }
};

/* ───────────────────────── TTS ───────────────────────── */

function ttsVoices() {
  try { return speechSynthesis.getVoices() || []; } catch { return []; }
}

// Sensible default: prefer a natural-sounding en voice when none is chosen.
function pickDefaultVoice() {
  const voices = ttsVoices();
  if (!voices.length) return null;
  const pref = [
    (v) => /natural|neural/i.test(v.name),
    (v) => /google (us|uk) english/i.test(v.name),
    (v) => /en[-_]/i.test(v.lang) && /microsoft|apple|zira|david|aria/i.test(v.name),
    (v) => /^en/i.test(v.lang),
  ];
  for (const p of pref) {
    const hit = voices.find(p);
    if (hit) return hit;
  }
  return voices[0];
}

function currentTtsVoice() {
  if (SET.ttsVoiceURI) {
    const v = ttsVoices().find((v) => v.voiceURI === SET.ttsVoiceURI);
    if (v) return v;
  }
  return pickDefaultVoice();
}

/* Speak via a local OpenAI-compatible TTS server (/v1/audio/speech):
 * openedai-speech, speaches, alltalk, etc. — small models like Piper with
 * trainable/clonable voices. Returns a promise that resolves when done. */
async function speakEndpoint(text) {
  const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  let batch = '', buffers = [];
  const flush = async () => {
    if (!batch.trim()) return;
    const res = await fetch(SET.ttsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SET.ttsModel || 'piper', input: batch.trim(), voice: SET.ttsVoiceName || undefined, response_format: 'wav' }),
    });
    if (!res.ok) throw new Error(`TTS server ${res.status}`);
    buffers.push(await res.blob());
    batch = '';
  };
  for (const c of chunks) {
    if ((batch + c).length > 600) await flush();
    batch += c;
  }
  await flush();
  S.speaking = true;
  $('btn-tts').classList.add('on');
  for (const b of buffers) {
    await new Promise((done) => {
      const a = new Audio(URL.createObjectURL(b));
      a.onended = done;
      a.onerror = done;
      a.play();
    });
  }
  S.speaking = false;
  $('btn-tts').classList.remove('on');
}

function speak(text) {
  if (!('speechSynthesis' in window) && SET.ttsBackend !== 'endpoint') {
    toast('Speech synthesis not supported', 'warning');
    return;
  }
  const clean = stripMarkdown(text);
  if (!clean) return;
  if (SET.ttsBackend === 'endpoint') {
    if (!SET.ttsEndpoint) { toast('Set a TTS server URL in settings first', 'warning'); return; }
    speechSynthesis.cancel();
    speakEndpoint(clean).catch((e) => {
      S.speaking = false;
      $('btn-tts').classList.remove('on');
      toast(`TTS failed: ${e.message}`, 'error');
    });
    return;
  }
  speechSynthesis.cancel();
  const voice = currentTtsVoice();
  // Chunk long text: some engines truncate very long utterances.
  for (const chunk of clean.match(/[\s\S]{1,220}(?=\s|$)|[\s\S]{1,220}/g) || []) {
    const u = new SpeechSynthesisUtterance(chunk);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = SET.ttsRate || 1.05;
    u.onend = () => {
      if (!speechSynthesis.speaking) { S.speaking = false; $('btn-tts').classList.remove('on'); }
    };
    speechSynthesis.speak(u);
  }
  S.speaking = true;
  $('btn-tts').classList.add('on');
}

speechSynthesis?.addEventListener?.('voiceschanged', () => populateTtsVoiceSelect());

function setAutoTts(on) {
  S.autoTts = on;
  applySettings();
  $('btn-tts').title = on ? 'Auto-speak ON — click to disable (or type /tts)' : 'Speak agent replies out loud (or type /tts)';
  if (!on) speechSynthesis.cancel();
  toast(on ? `Auto-speak enabled${currentTtsVoice() ? `: ${currentTtsVoice().name}` : ''}` : 'Auto-speak disabled');
}

$('btn-tts').onclick = () => setAutoTts(!S.autoTts);

/* ───────────────────────── sessions ───────────────────────── */

async function refreshSessions() {
  try {
    const res = await fetch('/api/sessions');
    const d = await res.json();
    renderSessions(d.sessions || []);
  } catch { /* ignore */ }
}

function renderSessions(sessions) {
  const list = $('session-list');
  const filter = ($('session-filter').value || '').toLowerCase();
  list.innerHTML = '';
  const current = S.state.sessionFile;
  // Fill the topbar name from the session's derived title (first user message)
  // when pi hasn't set an explicit session name and we're showing the raw
  // timestamp file name.
  if (current) {
    const base = current.split(/[\\/]/).pop().replace(/\.jsonl$/, '');
    const match = sessions.find((s) => s.path === current || s.fileName === base);
    const nameInput = $('session-name');
    if (match && (nameInput.value === base || nameInput.value === '')) {
      nameInput.value = match.name === base ? base : match.name;
      nameInput.title = `${match.name} — click to rename`;
    }
  }
  const shown = sessions.filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.fileName.toLowerCase().includes(filter));
  if (!shown.length) list.appendChild(el('div', 'session-item s-meta', 'No sessions found'));
  for (const s of shown) {
    const item = el('div', 'session-item');
    if (current && (s.path === current || s.fileName === current.split(/[\\/]/).pop())) item.classList.add('active');
    item.appendChild(el('div', 's-name', s.name));
    item.appendChild(el('div', 's-meta', `${new Date(s.mtime).toLocaleString()} · ${(s.size / 1024).toFixed(1)} KB`));
    item.onclick = () => switchToSession(s.path);
    list.appendChild(item);
  }
}

$('session-filter').oninput = () => refreshSessions();
$('btn-refresh-sessions').onclick = () => refreshSessions();

async function switchToSession(sessionPath) {
  try {
    await rpc({ type: 'switch_session', sessionPath });
    S.state.sessionFile = sessionPath;
    $('session-name').value = '';
    await initSession(false);
    toast('Session switched');
  } catch (e) { toast(`Switch failed: ${e.message}`, 'error'); }
}

$('btn-new-session').onclick = async () => {
  try {
    await rpc({ type: 'new_session' });
    await initSession(false);
    toast('New session started');
  } catch (e) { toast(e.message, 'error'); }
};

$('session-name').addEventListener('change', async (e) => {
  const name = e.target.value.trim();
  if (!name) return;
  try {
    await rpc({ type: 'set_session_name', name });
    await refreshSessions();
    toast('Session renamed');
  } catch (err) { toast(err.message, 'error'); }
});

/* ───────────────────────── model / thinking selects ───────────────────────── */

$('model-select').onchange = async (e) => {
  const [provider, ...rest] = e.target.value.split(':');
  try {
    await rpc({ type: 'set_model', provider, modelId: rest.join(':') });
    await rpc({ type: 'get_state' }).then(applyState);
    toast('Model switched');
  } catch (err) { toast(err.message, 'error'); }
};

$('thinking-select').onchange = async (e) => {
  try {
    await rpc({ type: 'set_thinking_level', level: e.target.value });
    toast(`Thinking level: ${e.target.value}`);
  } catch (err) { toast(err.message, 'error'); }
};

/* ───────────────────────── extension UI protocol ───────────────────────── */

function handleExtensionUi(req) {
  const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  switch (req.method) {
    case 'notify':
      toast(stripAnsi(req.message), req.notifyType === 'error' ? 'error' : req.notifyType === 'warning' ? 'warning' : 'info');
      break;
    case 'setStatus': {
      const bar = $('status-bar');
      bar.classList.remove('hidden');
      bar.dataset[req.statusKey] = stripAnsi(req.statusText);
      bar.textContent = Object.values(bar.dataset).join(' · ');
      break;
    }
    case 'setWidget': {
      const bar = $('widget-bar');
      const lines = (req.widgetLines || []).map(stripAnsi).filter((l) => l && l.trim());
      if (lines.length) bar.dataset[req.widgetKey] = lines.join('\n');
      else delete bar.dataset[req.widgetKey];
      const content = Object.values(bar.dataset).join('\n');
      bar.textContent = content;
      bar.classList.toggle('hidden', !content.trim());
      break;
    }
    case 'setTitle':
      document.title = `${stripAnsi(req.title) || 'Pi Agent'}`;
      break;
    case 'set_editor_text':
      input.value = req.text || '';
      autoSize();
      input.focus();
      break;
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor':
      showExtensionDialog(req);
      break;
    default:
      // Unknown request: respond cancelled so the agent doesn't block forever.
      send({ type: 'extension_ui_response', id: req.id, cancelled: true });
  }
}

function showExtensionDialog(req) {
  const dlg = $('ext-dialog');
  const body = $('ext-dialog-body');
  const cancel = $('ext-dialog-cancel');
  const ok = $('ext-dialog-ok');
  body.innerHTML = '';
  cancel.classList.remove('hidden');
  ok.textContent = 'OK';

  $('ext-dialog-title').textContent = req.title || 'Agent';
  const message = $('ext-dialog-message');
  if (req.message) { message.textContent = req.message; message.classList.remove('hidden'); }
  else message.classList.add('hidden');

  let control = null;
  let getVal = () => undefined;

  if (req.method === 'select') {
    control = el('select');
    for (const opt of req.options || []) {
      const o = el('option', null, typeof opt === 'string' ? opt : (opt.label || opt.value));
      o.value = typeof opt === 'string' ? opt : (opt.value ?? opt.label);
      control.appendChild(o);
    }
    body.appendChild(control);
    getVal = () => ({ value: control.value });
    ok.textContent = 'Select';
  } else if (req.method === 'confirm') {
    getVal = () => ({ confirmed: true });
    ok.textContent = 'Confirm';
  } else if (req.method === 'input') {
    control = el('input');
    control.placeholder = req.placeholder || '';
    body.appendChild(control);
    getVal = () => ({ value: control.value });
  } else if (req.method === 'editor') {
    control = el('textarea');
    control.value = req.prefill || '';
    body.appendChild(control);
    getVal = () => ({ value: control.value });
    ok.textContent = 'Save';
  }

  const done = (response) => {
    dlg.close();
    send({ type: 'extension_ui_response', id: req.id, ...response });
  };
  ok.onclick = () => done(getVal());
  cancel.onclick = () => done({ cancelled: true });
  dlg.oncancel = (e) => { e.preventDefault(); done({ cancelled: true }); };

  dlg.showModal();
  if (control) control.focus();
}

/* ───────────────────────── toasts / banner / misc ───────────────────────── */

function toast(text, kind = 'info') {
  const t = el('div', `toast ${kind}`, text);
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function showBanner(kind, text, btnLabel, fn) {
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.innerHTML = '';
  b.appendChild(el('span', null, text));
  if (btnLabel) {
    const btn = el('button', 'btn small', btnLabel);
    btn.onclick = () => { hideBanner(); fn(); };
    b.appendChild(btn);
  }
}

function hideBanner() {
  const b = $('banner');
  b.className = 'banner hidden';
}

function setConn(mode) {
  const d = $('conn-dot');
  d.className = `conn-dot ${mode}`;
  d.title = mode === 'on' ? 'Connected' : mode === 'busy' ? 'Agent is streaming' : 'Disconnected';
}

$('btn-toggle-sidebar').onclick = () => {
  if (window.matchMedia('(max-width: 760px)').matches) $('sidebar').classList.toggle('open');
  else document.body.classList.toggle('sidebar-hidden');
};

/* collapsible code boxes: one delegated listener for all rendered markdown */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.code-toggle');
  if (!btn) return;
  const box = btn.closest('.codebox');
  box.classList.toggle('collapsed');
  btn.textContent = box.classList.contains('collapsed') ? '+' : '\u2212';
});

/* periodically poll sessions list while idle */
setInterval(() => { if (!S.isStreaming) refreshSessions(); }, 20000);

/* ───────────────────────── settings dialog ───────────────────────── */

function populateTtsVoiceSelect() {
  const sel = $('set-tts-voice');
  if (!sel) return;
  const voices = ttsVoices();
  const current = currentTtsVoice();
  sel.innerHTML = '';
  for (const v of voices) {
    const o = el('option', null, `${v.name} (${v.lang})`);
    o.value = v.voiceURI;
    sel.appendChild(o);
  }
  if (voices.length) {
    sel.value = (SET.ttsVoiceURI && voices.some((v) => v.voiceURI === SET.ttsVoiceURI))
      ? SET.ttsVoiceURI
      : (current ? current.voiceURI : voices[0].voiceURI);
  } else {
    sel.appendChild(el('option', null, '(no voices installed)'));
  }
}

function openSettings() {
  $('set-agent-name').value = SET.agentName === 'pi' ? '' : SET.agentName;
  $('set-agent-name').placeholder = SET.agentName || 'pi';
  const prev = $('set-avatar-preview');
  if (SET.avatar) { prev.src = SET.avatar; prev.style.visibility = 'visible'; }
  else prev.style.visibility = 'hidden';
  $('set-voice-autosend').checked = !!SET.voiceAutoSend;
  $('set-show-thinking').checked = SET.showThinking !== false;
  $('set-expand-thinking').checked = !!SET.autoExpandThinking;
  $('set-expand-tools').checked = !!SET.autoExpandTools;
  $('set-stt-endpoint').value = SET.sttEndpoint || '';
  $('set-stt-backend').value = SET.sttBackend || 'whisper';
  $('set-tts-backend').value = SET.ttsBackend || 'browser';
  $('set-tts-endpoint').value = SET.ttsEndpoint || '';
  $('set-tts-model').value = SET.ttsModel || '';
  $('set-tts-voice-name').value = SET.ttsVoiceName || '';
  $('set-accent').value = SET.themeAccent || '#5b9dff';
  $('set-bg-url').value = SET.themeBg && !SET.themeBg.startsWith('data:') ? SET.themeBg : '';
  $('set-tts-rate').value = SET.ttsRate;
  $('set-tts-rate-val').textContent = Number(SET.ttsRate).toFixed(2);
  populateTtsVoiceSelect();
  $('settings-dialog').showModal();
}

$('btn-settings').onclick = openSettings;
$('settings-close').onclick = () => $('settings-dialog').close();

$('set-agent-name').addEventListener('change', (e) => {
  SET.agentName = e.target.value.trim() || 'pi';
  saveSettings();
  toast(`Agent renamed to "${SET.agentName}"`);
});

$('btn-avatar-upload').onclick = () => $('avatar-input').click();
$('avatar-input').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (!f.type.startsWith('image/')) { toast('Not an image', 'warning'); return; }
  const dataUrl = await readAsDataUrl(f);
  SET.avatar = dataUrl;
  saveSettings();
  toast('Profile image updated');
  e.target.value = '';
};
$('btn-avatar-clear').onclick = () => {
  SET.avatar = null;
  saveSettings();
  toast('Profile image removed');
};

$('set-tts-voice').onchange = (e) => { SET.ttsVoiceURI = e.target.value || null; saveSettings(); };
$('set-tts-rate').oninput = (e) => {
  SET.ttsRate = parseFloat(e.target.value);
  $('set-tts-rate-val').textContent = SET.ttsRate.toFixed(2);
};
$('set-tts-rate').onchange = () => saveSettings();
$('btn-tts-test').onclick = () => speak('This is how the agent will sound.');
$('set-voice-autosend').onchange = (e) => {
  SET.voiceAutoSend = e.target.checked;
  saveSettings();
};
$('set-show-thinking').onchange = (e) => {
  SET.showThinking = e.target.checked;
  saveSettings();
};
$('set-expand-thinking').onchange = (e) => {
  SET.autoExpandThinking = e.target.checked;
  saveSettings();
};
$('set-expand-tools').onchange = (e) => {
  SET.autoExpandTools = e.target.checked;
  saveSettings();
};
$('set-stt-endpoint').addEventListener('change', (e) => {
  SET.sttEndpoint = e.target.value.trim();
  saveSettings();
  toast(SET.sttEndpoint ? 'Whisper endpoint set — the mic will use it' : 'Whisper endpoint cleared — using browser voice');
});
$('set-stt-backend').onchange = (e) => {
  SET.sttBackend = e.target.value;
  saveSettings();
  toast(SET.sttBackend === 'whisper'
    ? 'Voice input: Whisper server' + (SET.sttEndpoint ? ` (${SET.sttEndpoint})` : ' (auto local server)')
    : 'Voice input: browser speech recognition (Chrome/Edge only)');
};
$('set-tts-backend').onchange = (e) => { SET.ttsBackend = e.target.value; saveSettings(); };
$('set-tts-endpoint').addEventListener('change', (e) => { SET.ttsEndpoint = e.target.value.trim(); saveSettings(); });
$('set-tts-model').addEventListener('change', (e) => { SET.ttsModel = e.target.value.trim(); saveSettings(); });
$('set-tts-voice-name').addEventListener('change', (e) => { SET.ttsVoiceName = e.target.value.trim(); saveSettings(); });
$('set-accent').addEventListener('input', (e) => { SET.themeAccent = e.target.value || null; saveSettings(); });
$('btn-accent-reset').onclick = () => { SET.themeAccent = null; saveSettings(); toast('Theme color reset'); };
$('set-bg-url').addEventListener('change', (e) => { SET.themeBg = e.target.value.trim() || null; saveSettings(); });
$('btn-bg-upload').onclick = () => $('bg-input').click();
$('bg-input').onchange = async (e) => {
  const f = e.target.files[0];
  if (f && f.type.startsWith('image/')) {
    SET.themeBg = await readAsDataUrl(f);
    saveSettings();
  }
  e.target.value = '';
};
$('btn-bg-clear').onclick = () => { SET.themeBg = null; saveSettings(); };

/* ───────────────────────── Instagram reels drawer ───────────────────────── */

/* Reels: opens the real, logged-in instagram.com/reels in a reusable popup
 * window. Browsers don't expose their native split view to pages, so the
 * button tooltip explains the manual split-view hotkey per browser. */
function reelsSplitHint() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'Firefox: Alt+click the Reels tab to open Split View beside the chat.';
  if (/Edg\//.test(ua)) return 'Edge: press Alt+F to open Split screen, then pick the Reels tab.';
  if (/Chrome\//.test(ua)) return 'Chrome: right-click the Reels tab and choose "New split view with current tab".';
  return 'Find the split view option in your browser, then pick the Reels tab.';
}

$('btn-reels').title = 'Open the reels feed. Split view: ' + reelsSplitHint();
$('btn-reels').onclick = () => {
  const w = Math.min(460, Math.max(360, Math.round(window.innerWidth * 0.42)));
  const h = Math.max(500, window.outerHeight - 60);
  const left = Math.max(0, window.screenX + window.outerWidth - w - 12);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  const existing = window.open('', 'pi_reels_feed');
  if (existing && !existing.closed) {
    existing.location.href = 'https://www.instagram.com/reels/';
    existing.focus();
  } else {
    window.open('https://www.instagram.com/reels/', 'pi_reels_feed',
      'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top);
  }
  toast('Reels opened beside the UI - ' + reelsSplitHint());
};

/* ───────────────────────── boot ───────────────────────── */

applySettings();
populateTtsVoiceSelect();
loadServerSettings();
connect();
