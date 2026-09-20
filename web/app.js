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
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n));
}

/* ── speech to text ───────────────────────────────────────────────────────
 * The browser's own recognition is the default: nothing to download and it is
 * good enough for dictating a prompt. The local whisper.cpp server is opt-in -
 * it pulls ~200 MB of binaries plus the chosen model, so it only starts when
 * the backend is set to whisper (or the button is pressed) and never on a plain
 * bridge launch. */
let sttModelsLoaded = false;

async function loadSttModels() {
  const sel = $('set-stt-model');
  if (!sel) return;
  try {
    const d = await fetch('/api/whisper-status').then((r) => r.json());
    sttModelsLoaded = true;
    sel.innerHTML = '';
    for (const m of d.models || []) {
      const o = el('option', null, `${m.label} - ${m.size}`);
      o.value = m.id;
      o.dataset.note = m.note || '';
      sel.appendChild(o);
    }
    syncSelect(sel, SET.sttModel || d.model);
    renderSttModelNote();
    renderSttStatus(d);
  } catch { /* offline bridge */ }
}

function renderSttModelNote() {
  const sel = $('set-stt-model');
  const note = $('stt-model-note');
  if (!sel || !note) return;
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  note.textContent = opt ? (opt.dataset.note || '') : '';
}

function renderSttStatus(st) {
  const box = $('stt-status');
  if (!box || !st) return;
  box.classList.remove('hidden');
  if (st.state === 'downloading') {
    const pct = st.total ? ` ${Math.floor((st.got / st.total) * 100)}%` : '';
    box.textContent = `Downloading ${st.detail || ''}${pct}`.trim();
  } else if (st.state === 'starting') {
    box.textContent = 'Starting the whisper server…';
  } else if (st.state === 'ready') {
    box.textContent = `Ready - ${st.detail || st.model}`;
  } else if (st.state === 'failed') {
    box.textContent = `Could not start it: ${st.detail || 'unknown error'}`;
  } else {
    box.textContent = 'Not running. "download & start" fetches whisper.cpp (~200 MB) and the model once.';
  }
}

async function refreshSttStatus() {
  try {
    const d = await fetch('/api/whisper-status').then((r) => r.json());
    renderSttStatus(d);
    if (d.state === 'downloading') setTimeout(refreshSttStatus, 1000);
  } catch { /* ignore */ }
}

/* Make sure a local whisper server is up, starting/downloading it if needed. */
async function ensureWhisper(quiet) {
  try {
    const st = await fetch('/api/whisper-status').then((r) => r.json());
    if (st.state === 'ready') return st.url || SET.sttEndpoint || null;
  } catch { /* fall through to the start call */ }
  if (!quiet) toast('Starting the local whisper server - first run downloads it, this takes a while…');
  const d = await fetch('/api/whisper-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SET.sttModel || null }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  if (d && d.ok) {
    if (d.url) { SET.sttEndpoint = d.url; saveSettings(); }
    return d.url || null;
  }
  toast(`Whisper server failed: ${(d && (d.error || d.detail)) || 'unknown error'}`, 'error');
  return null;
}

function wireVoiceSettings() {
  const backend = $('set-stt-backend');
  if (!backend) return;
  backend.onchange = () => { SET.sttBackend = backend.value; saveSettings(); syncVoiceSettingsUi(); };
  if ($('set-stt-model')) {
    $('set-stt-model').onchange = (e) => {
      SET.sttModel = e.target.value;
      renderSttModelNote();
      saveSettings();
    };
  }
  const startBtn = $('btn-stt-start');
  if (startBtn) {
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      await ensureWhisper(false);
      startBtn.disabled = false;
      refreshSttStatus();
    };
  }
  syncVoiceSettingsUi();
}

/* Show only what the chosen backend needs: the browser needs nothing, whisper
 * needs a model, an endpoint and a start button. */
function syncVoiceSettingsUi() {
  const backend = $('set-stt-backend');
  if (!backend) return;
  backend.value = SET.sttBackend === 'whisper' ? 'whisper' : 'browser';
  const whisper = backend.value === 'whisper';
  const modelSel = $('set-stt-model');
  const modelRow = modelSel && modelSel.closest('.rate-row');
  const startBtn = $('btn-stt-start');
  const endpoint = $('set-stt-endpoint');
  const note = $('stt-model-note');
  const status = $('stt-status');
  if (modelRow) modelRow.classList.toggle('hidden', !whisper);
  if (startBtn) startBtn.classList.toggle('hidden', !whisper);
  if (endpoint && endpoint.parentElement) endpoint.parentElement.classList.toggle('hidden', !whisper);
  if (note) note.classList.toggle('hidden', !whisper);
  if (status) status.classList.toggle('hidden', !whisper);
  document.querySelectorAll('#tab-voice .settings-grid > label').forEach((l) => {
    const t = (l.textContent || '').trim();
    if (t === 'Whisper model' || t === 'Whisper endpoint') l.classList.toggle('hidden', !whisper);
  });
  // Fetch the list even when browser STT is selected: it is one request, and
  // otherwise the whisper choices (including the multilingual model) only
  // existed after you had already switched to whisper and back.
  if (!sttModelsLoaded) loadSttModels();
  if (whisper) { loadSttModels(); refreshSttStatus(); }
}

/* Live elapsed-time timer for a running tool card (bash etc.). */
function fmtElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
}
/* Restart the counter from now - used when the timeout becomes known, so the
 * countdown starts with the command instead of with the card appearing. */
function restartCardTimer(card) {
  if (card._timer) { clearInterval(card._timer); card._timer = null; }
  card._running = false;
  startCardTimer(card);
}

function startCardTimer(card) {
  if (card._timer) return;
  card._running = true;
  card._start = Date.now();
  const tick = () => {
    card.timerEl.classList.remove('hidden');
    // Always counts up: the countdown a bash timeout used to produce looked
    // like a timer that was running backwards, and "3:00 left" said nothing
    // about how long the call had already been going.
    card.timerEl.textContent = fmtElapsed(Date.now() - card._start);
    if (card._timeoutMs) {
      card.timerEl.title = `timeout ${Math.round(card._timeoutMs / 1000)}s`;
      card.timerEl.classList.toggle('over-timeout', Date.now() - card._start > card._timeoutMs);
    }
  };
  tick();
  card._timer = setInterval(tick, 1000);
}
function stopCardTimer(card, stateText) {
  if (card._timer) {
    clearInterval(card._timer);
    card._timer = null;
  }
  card._running = false;
  // Always update the state text, even when no timer was running (the card
  // may have been created without one) — otherwise it stays stuck on
  // "running…" while the class already shows done/error. The label lives in
  // its own span so the "running…" text can bob while the elapsed time sits
  // still next to it.
  const label = card.stateEl.querySelector('.tool-state-label');
  const suffix = card._start ? ` · ${fmtElapsed(Date.now() - card._start)}` : '';
  if (card._start) card.timerEl.textContent = fmtElapsed(Date.now() - card._start);
  if (label) {
    label.textContent = stateText;
    card.stateEl.replaceChildren(...(suffix ? [label, document.createTextNode(suffix)] : [label]));
  } else {
    card.stateEl.textContent = stateText + suffix;
  }
  card.stateEl.classList.remove('running');
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

/* Same line, but from the character estimate: "↓ ~523 write @ 18.6 t/s". */
function estStatsText(est, sec) {
  if (!est) return '';
  return `↓ ~${formatTok(est) || 0} write` + (sec && sec > 0.2 ? ` @ ${(est / sec).toFixed(1)} t/s` : '');
}

/* Type anywhere: with the setting on, any printable keystroke while the window
 * is focused lands in the composer without clicking it first. Focusing on
 * keydown (rather than blocking the key) lets the browser deliver that same
 * keystroke to the newly focused box. */
function wireTypeAnywhere() {
  window.addEventListener('keydown', (e) => {
    if (SET.typeAnywhere !== true) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1 && e.key !== 'Backspace' && e.key !== 'Enter') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Enter') { e.preventDefault(); input.focus(); return; }
    input.focus();
  });
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
  showToolCalls: true,    // show/hide tool call cards entirely
  autoExpandThinking: false, // render thinking blocks open by default
  autoExpandTools: false, // render tool call output open by default
  sttEndpoint: '',        // whisper-compatible transcription endpoint
  sttBackend: 'browser',  // 'browser' (built in, default) | 'whisper' (local server, downloaded on demand)
  sttModel: 'ggml-base.en.bin', // whisper.cpp model id
  instances: [],          // other pi agents to switch between: [{id, name, url}]
  ttsBackend: 'browser',  // 'browser' | 'endpoint'
  ttsEndpoint: '',        // OpenAI-compatible /v1/audio/speech server (Piper etc.)
  ttsModel: 'piper',
  ttsVoiceName: '',
  themeAccent: null,      // custom accent color
  themeBg: null,          // background image (URL or dataURL) or video URL
  onboarded: false,       // first-launch setup completed
  shortsProvider: 'instagram', // 'instagram' | 'tiktok' | 'youtube' | 'none'
  shortsAutoOpen: false,  // open the feed while the agent runs, close it when the run finishes
  shortsMode: 'panel',    // 'panel' (in-app split) | 'window' (side window, full feed) | 'tab' — legacy 'split'='panel', 'popup'='window'
  reelsWidth: null,       // px — the shorts panel width, remembered across launches
  reelsOpen: false,       // was the shorts panel open? restored on load
  forkCollapsed: {},      // parent session path -> true while its branches are folded away
  autoContinueAfterCompaction: true, // nudge the agent to keep working after a compaction
  fontFamily: '',         // '' | 'mono' | 'serif' | 'rounded' | a system font family
  chatFontSize: 14,       // px — chat + composer text size
  chatOpacity: 100,       // 0-100 — chat chrome (composer/topbar/sidebar) opacity
  textOutline: true,      // outline chat text so it stays readable over a background
  textOutlineColor: '#000000', // outline colour
  avatarSize: 34,         // px — agent profile image in the chat
  avatarCrop: null,       // {x, y, z} — manual crop of the profile image
  bgCrop: null,           // {x, y, z} — manual crop of the background
  typeAnywhere: false,    // start typing in the composer without clicking it
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
  refreshAvatars();
  // thinking blocks visibility
  document.body.classList.toggle('hide-thinking', SET.showThinking === false);
  document.body.classList.toggle('hide-tools', SET.showToolCalls === false);
  const stt = $('set-show-tools');
  if (stt) stt.checked = SET.showToolCalls !== false;
  const st = $('set-show-thinking');
  if (st) st.checked = SET.showThinking !== false;
  // theme
  const rootStyle = document.documentElement.style;
  // text outline: a 4-way shadow keeps glyphs readable when the panels are
  // translucent and the background image shows through.
  document.body.classList.toggle('text-outline', SET.textOutline !== false);
  rootStyle.setProperty('--outline-color', SET.textOutlineColor || '#000000');
  const avSize = Math.max(16, Math.min(120, Number(SET.avatarSize) || 34));
  rootStyle.setProperty('--avatar-size', `${avSize}px`);
  if (SET.themeAccent) {
    rootStyle.setProperty('--accent', SET.themeAccent);
    rootStyle.setProperty('--accent-dim', `color-mix(in srgb, ${SET.themeAccent} 35%, #171b22)`);
  } else {
    rootStyle.removeProperty('--accent');
    rootStyle.removeProperty('--accent-dim');
  }
  applyBackgroundMedia();
  // chat-panel transparency (0 = fully transparent, 100 = solid)
  const alpha = SET.chatOpacity == null ? 1 : Math.max(0, Math.min(1, Number(SET.chatOpacity) / 100));
  rootStyle.setProperty('--ui-alpha', String(alpha));
  // chat font + text size. SET.fontFamily is either a preset key ('', mono,
  // serif, rounded) or a raw system font family name from the picker.
  const FONT_MAP = {
    '': '"Segoe UI", system-ui, -apple-system, sans-serif',
    mono: 'var(--mono)',
    serif: 'Georgia, "Times New Roman", serif',
    rounded: '"Comfortaa", "Varela Round", "Trebuchet MS", "Segoe UI", sans-serif',
  };
  const fontCss = FONT_MAP[SET.fontFamily] ?? (SET.fontFamily ? `"${SET.fontFamily}", sans-serif` : FONT_MAP['']);
  rootStyle.setProperty('--chat-font', fontCss);
  rootStyle.setProperty('--chat-size', `${Number(SET.chatFontSize) || 14}px`);
  // shorts button follows the chosen feed
  const reels = $('btn-reels');
  if (reels) {
    const feed = SHORTS_FEEDS[SET.shortsProvider || 'instagram'];
    if (feed) {
      reels.style.display = '';
      reels.textContent = feed.label;
      const mode = SET.shortsMode || 'panel';
      const modeLabel = mode === 'tab' ? 'new tab' : mode === 'window' ? 'side window (full feed)' : 'in-app split panel';
      reels.title = `Open ${feed.label} with one tap (${modeLabel})`;
    } else {
      reels.style.display = 'none';
    }
  }
  // auto-expand state on already-rendered elements
  document.querySelectorAll('details.thinking').forEach((d) => { d.open = SET.autoExpandThinking === true; });
  document.querySelectorAll('.tool-card .tool-body').forEach((b) => {
    b.classList.toggle('hidden', SET.autoExpandTools !== true);
  });
  // Runs here, once the settings are in: ?from=<instance> from the switcher.
  absorbFromParam();
}

/* ───────────────────────── state ───────────────────────── */

const S = {
  ws: null,
  reqId: 0,
  pending: new Map(),      // req id -> resolve fn
  commands: [],            // from get_commands (extension / prompt / skill)
  builtinCommands: [],     // from /api/builtin-commands (pi's built-in slash commands)
  forkable: [],            // from get_fork_messages: [{entryId, text}]
  forkEntries: [],         // from get_entries - same idea, but everything in the file
  state: {},               // last get_state payload
  isStreaming: false,
  compacting: false,        // true while a compaction is in flight
  compactionQueue: [],      // prompts queued while compacting (sent after it finishes)
  compactionHappened: false,   // a compaction completed during this run → re-render history on settle
  compactionNeedsContinue: false, // compaction finished without auto-retry → maybe auto-continue
  lastAutoContinueAt: 0,       // cooldown guard for auto-continue nudges
  queue: { steering: [], followUp: [] },
  editMode: null,          // {entryId, originalText}
  attachments: [],         // [{data, mimeType, name}]
  models: [],
  levels: [],
  instanceStatus: {},       // instance url -> {ok, busy, name} for the switcher
  msgTiming: new Map(),    // message key -> {elapsedSec, prefillSec, est} for the t/s figure
  autoTts: false,
  speaking: false,
  stickToBottom: true,
  userScrolling: false,    // true during an active wheel/touch gesture (never pin then)
  live: null,              // in-flight assistant render {root, text, thinking, tools}
  toolCards: new Map(),    // toolCallId -> {card, body, stateEl}
  viewSession: null,       // session path being viewed (null = the agent's own session)
  liveDetached: null,      // { path, frag } — running session's live DOM, parked while viewing another
  sessionsList: [],        // last /api/sessions payload (path -> name lookup for the view banner)
  compactionLive: null,    // live "compacting…" block {root, t}
  lastCompaction: null,    // last compaction_end result (for the marker's "after" count)
  // Compactions we watched happen in this page session. Each is anchored to the
  // message index it sat at, so it stays put instead of being re-appended to the
  // bottom of the transcript on every turn.
  compactionMarks: [],     // [{ summary, tokensBefore, estimatedTokensAfter, at }]  (at = ms)
  ctxStats: null,          // last authoritative contextUsage from get_session_stats
  ctxDisplayTokens: null,  // high-water mark: the largest token count the ring has shown
  ctxBaseTokens: null,     // authoritative count when the current turn started
  tokPerChar: null,        // measured output-tokens-per-character for this session
  bashCards: new Map(),    // bash req id -> {body}
  initialized: false,
  totals: { read: 0, write: 0 },  // session token totals
};

const chat = $('chat');

/* ───────────────────────── websocket / rpc ───────────────────────── */

let reconnectTimer = null;  // auto-reconnect after a dropped connection
let reconnectDelay = 1000;  // backoff per failed attempt, capped at 15s

function connect() {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) return; // already connected
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;

  ws.onopen = () => {
    reconnectDelay = 1000; // a healthy connection resets the backoff
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setConn('on');
    hideBanner();
    initSession(true);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.bridge === 'rpc') handleRpcMessage(msg.payload);
    else if (msg.bridge === 'agent_exit') onAgentExit(msg);
    else if (msg.bridge === 'agent_started') onAgentStarted();
    else if (msg.bridge === 'agent_stderr' && msg.text.trim()) console.warn('[pi stderr]', msg.text);
  };
  ws.onclose = () => {
    // Everything in here is cleanup, and any one step throwing used to skip the
    // reconnect below - leaving the page sitting there disconnected, with the
    // whole UI quietly broken until a manual reload.
    try {
      setConn('off');
      S.isStreaming = false;
      // Connection lost mid-turn: mark any live tool cards as failed so they
      // don't sit on "running…" forever.
      markStuckToolCards('connection lost');
      removeCompactionLive();
      // In-flight RPCs will never get a response — fail them now instead of
      // making callers wait out their full timeout.
      for (const [id, p] of [...S.pending]) {
        S.pending.delete(id);
        p.reject(new Error('connection lost'));
      }
      updateStreamUi();
      showBanner('error', 'Connection to the bridge lost — reconnecting…', 'Retry now', () => connect());
    } catch (e) {
      console.warn('reconnect cleanup failed:', e && e.message);
    }
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose follows */ };
}

/* Reconnect automatically with backoff — a manual page reload used to be the
 * only way to recover from a dropped connection. onopen re-runs initSession,
 * which re-syncs the whole UI from the bridge, so the desync heals itself. */
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (S.ws && S.ws.readyState === WebSocket.OPEN) return;
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  }, reconnectDelay);
}

/* Liveness heartbeat: a half-open WebSocket (sleep/wake, WebView2 network
 * hiccup) may never fire onclose on its own, leaving the UI frozen on a dead
 * connection. A cheap get_state with a short timeout detects that — if it
 * never answers, force a close so the onclose path can reconnect. */
setInterval(() => {
  const ws = S.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    rpc({ type: 'get_state' }, 10000).catch((e) => {
      // Only a timeout means the connection is dead; an error response
      // (e.g. agent restarting) means the bridge is alive.
      if (!/timed out/.test(e.message)) return;
      try { ws.close(); } catch { /* already closing */ }
    });
  }
}, 25000);

function send(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

/* Resolve when the (re)started agent reports agent_started. */
let agentReadyWaiters = [];
function onAgentStarted() {
  // A fresh agent means the crash banner is stale - it used to sit there until
  // the page was reloaded, even after a successful restart.
  hideBanner();
  refreshCommands().catch(() => {});
  refreshBuiltinCommands().catch(() => {});
  refreshModels().catch(() => {});
  refreshLevels().catch(() => {});
  refreshStats().catch(() => {});
  const w = agentReadyWaiters;
  agentReadyWaiters = [];
  w.forEach((r) => r());
}
function waitForAgentReady(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const i = agentReadyWaiters.indexOf(resolve);
      if (i >= 0) agentReadyWaiters.splice(i, 1);
      reject(new Error('agent did not start in time'));
    }, timeoutMs);
    agentReadyWaiters.push(() => { clearTimeout(t); resolve(); });
  });
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
      if (!msg.success) {
        // A session whose recorded folder is gone gets its own dialog in
        // switchToSession; the raw pi error is not useful on top of that.
        const handledElsewhere = msg.command === 'switch_session' &&
          /working directory does not exist/i.test(msg.error || '');
        // An oversized-tree stack overflow here is self-inflicted (leafPath) and
        // harmless; putting it in the transcript looked like the agent broke.
        if (/Maximum call stack size exceeded/i.test(String(msg.error))) {
          console.warn(`handled silently (${msg.command}): ${msg.error}`);
        } else if (!handledElsewhere) toast(`Agent error (${msg.command}): ${msg.error}`, 'error');
      }
    }
    return;
  }
  if (msg.type === 'extension_ui_request') { handleExtensionUi(msg); return; }
  handleEvent(msg);
}

/* Mark every live tool card that is still "running" as failed — the agent
 * exited or the connection dropped, so the command can no longer be running. */
function markStuckToolCards(label) {
  for (const card of S.toolCards.values()) {
    if (card._timer || card.stateEl.textContent.startsWith('running')) {
      stopCardTimer(card, label);
      card.stateEl.className = 'tool-state error';
    }
  }
}

function onAgentExit(msg) {
  S.isStreaming = false;
  setConn('on');
  // Any tool card still showing "running…" is stuck — the agent is gone.
  markStuckToolCards('interrupted');
  removeCompactionLive();
  updateStreamUi(); // live dot, Stop button, ctx poll, view banner
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
    if (d.model && d.model.id) syncSelect($('model-select'), `${d.model.provider}||${d.model.id}`);
    if (d.thinkingLevel) syncSelect($('thinking-select'), d.thinkingLevel);
    updateStreamUi();
    // Reconnect while a run is already going: the feed should be open too.
    if (d.isStreaming) autoOpenShortsIfEnabled();
  }
}

function syncSelect(sel, value) {
  if (value && [...sel.options].some((o) => o.value === value)) sel.value = value;
  if (sel && sel.id === 'model-select') updateModelBtn();
  if (sel && sel.id === 'thinking-select') updateThinkingBtn();
}

/* ── shared dropdown menu ─────────────────────────────────────────────────
 * The model picker's look - search box, scrollable rows, groups, accent on the
 * current entry - reused for the thinking levels, the session and turn context
 * menus and the instance switcher, so they all behave the same way. */
let openMenuEl = null;
function closeMenu() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}

/* Only one dropdown may be on screen. Every opener goes through this, and a
 * capture-phase pointerdown closes whichever menu was not clicked - so the
 * model menu and the thinking menu can never overlap, whatever route opened
 * them. */
function closeAllMenus() {
  closeMenu();
  toggleModelMenu(false);
}
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  if (!t.closest('#model-menu') && !t.closest('#model-btn')) toggleModelMenu(false);
  if (!t.closest('.model-menu')) closeMenu();
}, true);

function openMenu(anchor, items, opts = {}) {
  const wasOpenFor = openMenuEl && openMenuEl._anchor === anchor;
  closeMenu();
  toggleModelMenu(false);
  if (wasOpenFor && !opts.force) return null;   // clicking the same anchor again closes
  if (!anchor || !items || !items.length) return null;
  const menu = el('div', 'model-menu');
  menu._anchor = anchor;
  let search = null;
  if (opts.search) {
    search = el('input');
    search.type = 'search';
    search.placeholder = opts.search;
    search.autocomplete = 'off';
    search.spellcheck = false;
    menu.appendChild(search);
  }
  if (opts.title) menu.appendChild(el('div', 'model-group', opts.title));
  const list = el('div', 'model-list');
  const render = (q) => {
    list.replaceChildren();
    const query = (q || '').trim().toLowerCase();
    const rows = items.filter((it) => !query ||
      `${it.label || ''} ${it.hint || ''} ${it.group || ''}`.toLowerCase().includes(query));
    if (!rows.length) { list.appendChild(el('div', 'model-empty', 'Nothing matches')); return; }
    let group = null;
    for (const it of rows) {
      if (it.sep) { list.appendChild(el('div', 'menu-sep', '')); group = null; continue; }
      if (it.group && it.group !== group) { group = it.group; list.appendChild(el('div', 'model-group', group)); }
      const row = el('div', 'model-item' + (it.active ? ' sel' : '') + (it.danger ? ' danger' : ''));
      if (it.dot) row.appendChild(el('span', `menu-dot ${it.dot}`, ''));
      row.appendChild(el('span', 'model-label', it.label || ''));
      if (it.hint) row.appendChild(el('span', 'model-provider', it.hint));
      row.onclick = (e) => {
        e.stopPropagation();
        if (it.keepOpen) { it.onPick && it.onPick(it); return; }
        closeMenu();
        it.onPick && it.onPick(it);
      };
      list.appendChild(row);
    }
  };
  menu.appendChild(list);
  render('');
  if (search) {
    search.oninput = () => render(search.value);
    search.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
      if (e.key === 'Enter') { const first = list.querySelector('.model-item'); if (first) first.click(); }
    };
  }
  document.body.appendChild(menu);
  openMenuEl = menu;
  const r = anchor.getBoundingClientRect();
  const w = Math.max(200, Math.min(opts.width || 300, window.innerWidth - 24));
  menu.style.width = `${w}px`;
  const h = menu.offsetHeight;
  if (opts.at) {
    // Right-click menus appear where the pointer is, not at the message header.
    const left = Math.max(8, Math.min(opts.at.x, window.innerWidth - w - 8));
    const top = opts.at.y + h + 8 > window.innerHeight ? Math.max(8, opts.at.y - h - 6) : opts.at.y + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  } else {
    const roomBelow = window.innerHeight - r.bottom - 10;
    if (roomBelow < Math.min(h, 220) && r.top > roomBelow) menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
    else menu.style.top = `${Math.min(r.bottom + 6, Math.max(8, window.innerHeight - h - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(opts.align === 'right' ? r.right - w : r.left, window.innerWidth - w - 8))}px`;
  }
  if (search) search.focus();
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  return menu;
}

/* What each thinking level means - shown in the dropdown, not on the button. */
const THINKING_NOTES = {
  off: 'no thinking - fastest replies',
  minimal: 'a quick look before answering',
  low: 'brief reasoning',
  medium: 'balanced - the usual choice',
  high: 'thorough reasoning, slower on hard problems',
  max: 'the most it can do - slowest',
};

function updateThinkingBtn() {
  const btn = $('thinking-btn');
  if (!btn) return;
  const sel = $('thinking-select');
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  btn.textContent = opt ? opt.value : 'off';
  btn.title = `Thinking level: ${opt ? opt.value : 'off'} - click to change`;
}

function openThinkingMenu() {
  const sel = $('thinking-select');
  const levels = [...sel.options].map((o) => o.value);
  openMenu($('thinking-btn'), levels.map((lv) => ({
    label: lv,
    hint: THINKING_NOTES[lv] || '',
    active: sel.value === lv,
    onPick: () => {
      sel.value = lv;
      sel.dispatchEvent(new Event('change'));
    },
  })), { title: 'thinking level', width: 330 });
}

/* ── model picker ─────────────────────────────────────────────────────────
 * A native <select> cannot be searched, and with enough models its popup ran
 * off the bottom of the screen. This adds a searchable, scrollable list on top
 * of it. The hidden <select> stays the source of truth (set_model, state sync,
 * llama.cpp entries) so nothing else had to change. */
function modelMenuItems() {
  const sel = $('model-select');
  const out = [];
  for (const kid of sel.children) {
    if (kid.tagName === 'OPTGROUP') {
      for (const o of kid.children) out.push({ value: o.value, label: o.textContent, group: kid.label || '' });
    } else if (kid.tagName === 'OPTION') {
      out.push({ value: kid.value, label: kid.textContent, group: '' });
    }
  }
  return out;
}

function updateModelBtn() {
  const btn = $('model-btn');
  if (!btn) return;
  const sel = $('model-select');
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  const label = opt ? opt.textContent : 'no model';
  btn.textContent = label;
  btn.title = `Model: ${label} — click to search and switch`;
}

function renderModelMenu(query) {
  const list = $('model-list');
  if (!list) return;
  const q = (query || '').trim().toLowerCase();
  const sel = $('model-select').value;
  const items = modelMenuItems().filter((it) =>
    !q || it.label.toLowerCase().includes(q) || it.value.toLowerCase().includes(q) || it.group.toLowerCase().includes(q));
  list.replaceChildren();
  if (!items.length) {
    list.appendChild(el('div', 'model-empty', q ? `No model matches “${query}”` : 'No models reported yet'));
    return;
  }
  let group = null;
  for (const it of items) {
    if (it.group && it.group !== group) {
      group = it.group;
      list.appendChild(el('div', 'model-group', group));
    }
    const row = el('div', 'model-item' + (it.value === sel ? ' sel' : ''));
    row.appendChild(el('span', 'model-label', it.label));
    if (!it.group) row.appendChild(el('span', 'model-provider', it.value.split('||')[0]));
    row.onclick = () => {
      const s = $('model-select');
      s.value = it.value;
      s.dispatchEvent(new Event('change'));
      toggleModelMenu(false);
    };
    list.appendChild(row);
  }
}

function toggleModelMenu(open) {
  const menu = $('model-menu');
  if (!menu) return;
  const show = open == null ? menu.classList.contains('hidden') : open;
  if (!show) { menu.classList.add('hidden'); return; }
  closeMenu();   // one dropdown at a time - the thinking menu used to stay open behind it
  const btn = $('model-btn');
  const r = btn.getBoundingClientRect();
  const width = Math.max(280, Math.min(420, window.innerWidth - 24));
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  $('model-search').value = '';
  renderModelMenu('');
  menu.classList.remove('hidden');
  $('model-search').focus();
  const cur = menu.querySelector('.model-item.sel');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

(function wireModelMenu() {
  const btn = $('model-btn');
  const menu = $('model-menu');
  if (!btn || !menu) return;
  btn.onclick = (e) => { e.stopPropagation(); refreshLlamaGroupThrottled(); toggleModelMenu(); };
  // Any change to the select (state sync, llama.cpp entry, a pick from the list)
  // has to be reflected on the button.
  $('model-select').addEventListener('change', () => updateModelBtn());
  $('model-search').oninput = (e) => renderModelMenu(e.target.value);
  $('model-search').onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); toggleModelMenu(false); input.focus(); }
    if (e.key === 'Enter') {
      const first = menu.querySelector('.model-item:not(.sel)') || menu.querySelector('.model-item.sel') || menu.querySelector('.model-item');
      if (first) first.click();
    }
  };
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleModelMenu(false));
})();

async function refreshModels() {
  try {
    const d = await rpc({ type: 'get_available_models' });
    S.models = asArray(d, 'models');
    const sel = $('model-select');
    sel.innerHTML = '';
    for (const m of S.models) {
      const o = el('option', null, `${m.name || m.id}`);
      // "||" separator: provider ids can contain colons (llama-server=http://host:8080)
      o.value = `${m.provider}||${m.id}`;
      sel.appendChild(o);
    }
    ensureLlamaGroup(); // retried in the background until the server answers
    if (S.state.model) syncSelect(sel, `${S.state.model.provider}||${S.state.model.id}`);
    updateModelBtn();
  } catch { /* agent may not implement it */ }
}

/* llama.cpp: query the router(s) directly so every model the server knows
 * about shows up — even ones pi has not registered yet. Selecting one sends
 * set_model with the "llama-server=<url>" provider id the pi-llama-cpp
 * extension uses. If pi has not registered that provider (e.g. its configured
 * URL is unreachable), a banner offers to point pi at the live server and
 * restart the agent so the model becomes selectable. */
let llamaLiveServers = [];
let llamaConfiguredUrl = null;
let llamaMismatchBanner = false;
let llamaFixInFlight = false;

async function refreshLlamaGroup() {
  const sel = $('model-select');
  const old = sel.querySelector('optgroup[data-llama]');
  if (old) old.remove();
  try {
    const [d, cfg] = await Promise.all([
      fetch('/api/llama-models').then((r) => r.json()),
      fetch('/api/llama-config').then((r) => r.json()),
    ]);
    llamaConfiguredUrl = cfg.url || null;
    llamaLiveServers = d.servers || [];
    if (!llamaLiveServers.length) {
      hideLlamaMismatch();
      return;
    }
    const known = new Set(S.models.map((m) => `${m.provider}||${m.id}`));
    // The same model can be registered by pi under its own provider id and
    // appear again here under "llama-server=<url>", which showed every local
    // model twice. Match on the model id as well - these ids are unique per
    // file on the server.
    const knownIds = new Set(S.models.map((m) => m.id));
    const group = el('optgroup', null, 'llama.cpp (local)');
    group.dataset.llama = '1';
    let unregistered = null;
    for (const srv of llamaLiveServers) {
      const short = srv.url.replace(/^https?:\/\//, '');
      const registered = S.models.some((m) => m.provider === srv.providerId);
      if (!registered && !unregistered) unregistered = srv;
      for (const m of srv.models) {
        const key = `${srv.providerId}||${m.id}`;
        if (known.has(key) || knownIds.has(m.id)) continue; // already listed by the agent itself
        const o = el('option', null, llamaLiveServers.length > 1 ? `${m.name || m.id} · ${short}` : (m.name || m.id));
        o.value = key;
        group.appendChild(o);
      }
    }
    if (group.children.length) sel.appendChild(group);
    if (unregistered) showLlamaMismatch(unregistered);
    else hideLlamaMismatch();
  } catch { /* bridge offline or no llama.cpp server */ }
}

function showLlamaMismatch(srv) {
  const short = srv.url.replace(/^https?:\/\//, '');
  const configured = (llamaConfiguredUrl && llamaConfiguredUrl !== srv.url)
    ? `pi is configured for ${llamaConfiguredUrl.replace(/^https?:\/\//, '')} (unreachable)`
    : 'pi has not registered it yet';
  showBanner('warn',
    `llama.cpp server found at ${short} with ${srv.models.length} models, but ${configured} — selecting its models will fail until pi is pointed at it. pi needs the pi-llama-cpp extension to register it (install with: pi install npm:pi-llama-cpp), then point pi at this server and restart.`,
    'Point pi here & reload',
    () => fixLlamaConfig(srv.url));
  llamaMismatchBanner = true;
}

function hideLlamaMismatch() {
  if (!llamaMismatchBanner) return;
  llamaMismatchBanner = false;
  hideBanner();
}

/* One-click fix: write the live URL into pi's global settings, restart the
 * agent (pi-llama-cpp resolves the URL at startup), then retry the model
 * the user was trying to select. */
async function fixLlamaConfig(url) {
  if (llamaFixInFlight) return;
  llamaFixInFlight = true;
  toast('Updating pi config and restarting the agent…');
  try {
    const r = await fetch('/api/llama-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
    const wait = waitForAgentReady(60000);
    send({ bridge: 'restart' });
    await wait;
    await initSession(true); // full re-init: resume last session + refresh models
    hideLlamaMismatch();
    if (S.pendingModel) {
      const pm = S.pendingModel;
      S.pendingModel = null;
      try {
        await rpc({ type: 'set_model', provider: pm.provider, modelId: pm.modelId });
        await rpc({ type: 'get_state' }).then(applyState);
        toast(`Model switched: ${pm.modelId}`);
      } catch (e) {
        toast(`Agent restarted, but model switch failed: ${e.message}`, 'error');
      }
    }
  } catch (e) {
    toast(`Fix failed: ${e.message}`, 'error');
  } finally {
    llamaFixInFlight = false;
  }
}

/* The llama.cpp server may still be starting up (or pi's own 1s health check
 * at startup may have skipped it), so keep re-probing in the background until
 * at least one server answers. */
const LLAMA_RETRY_DELAYS = [3000, 5000, 10000, 15000, 20000, 30000];
async function ensureLlamaGroup(attempt = 0) {
  await refreshLlamaGroup();
  const g = $('model-select').querySelector('optgroup[data-llama]');
  // Stop retrying once every live server is registered with pi (its models
  // then appear in the main list, so the optgroup is intentionally empty).
  const allRegistered = llamaLiveServers.length > 0 &&
    llamaLiveServers.every((s) => S.models.some((m) => m.provider === s.providerId));
  if ((g && g.children.length) || allRegistered || attempt >= LLAMA_RETRY_DELAYS.length) return;
  setTimeout(() => { ensureLlamaGroup(attempt + 1); }, LLAMA_RETRY_DELAYS[attempt]);
}

let llamaGroupRefreshAt = 0;
$('model-select').addEventListener('focus', () => {
  const now = Date.now();
  if (now - llamaGroupRefreshAt < 10000) return; // throttle: max once per 10s
  llamaGroupRefreshAt = now;
  refreshLlamaGroup();
});
/* The select is hidden behind the model button now, so the same refresh runs
 * when the picker is opened. */
function refreshLlamaGroupThrottled() {
  const now = Date.now();
  if (now - llamaGroupRefreshAt < 10000) return;
  llamaGroupRefreshAt = now;
  refreshLlamaGroup();
  updateModelBtn();
}

async function refreshLevels() {
  try {
    const d = await rpc({ type: 'get_available_thinking_levels' });
    S.levels = asArray(d, 'levels');
    const sel = $('thinking-select');
    sel.innerHTML = '';
    (S.levels.length ? S.levels : ['off']).forEach((lv) => {
      // The button shows the bare level ("off", "low"); the description is for
      // the dropdown only.
      const o = el('option', null, lv);
      o.value = lv;
      sel.appendChild(o);
    });
    if (S.state.thinkingLevel) syncSelect(sel, S.state.thinkingLevel);
    updateThinkingBtn();
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
  // Fork ids must come from the *active branch*. The file also holds abandoned
  // branches from earlier forks, so walking it in file order shifted every id
  // after the first fork - which is why right-clicking a turn forked somewhere
  // else. The tree plus leafId gives exactly the conversation on screen.
  try {
    const d = await rpc({ type: 'get_tree' });
    const path = leafPath(d && d.tree, d && d.leafId);
    const users = path
      .filter((e) => e && e.message && e.message.role === 'user')
      .map((e) => ({ entryId: e.id, text: (e.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ') }));
    S.forkEntries = users.length ? users : (S.forkable || []).map((f) => ({ entryId: f.entryId, text: f.text }));
  } catch {
    S.forkEntries = (S.forkable || []).map((f) => ({ entryId: f.entryId, text: f.text }));
  }
}

/* The entries from the root down to the current leaf - the active branch. */
function leafPath(tree, leafId) {
  if (!Array.isArray(tree)) return [];
  // Iterative on purpose: a long session's branch is one node deep per message,
  // and the recursive version blew the call stack on big sessions - which pi
  // reported as "Agent error (get_tree): Maximum call stack size exceeded" at
  // the start of every turn.
  const seen = new Set();
  const stack = [];
  for (let i = tree.length - 1; i >= 0; i--) stack.push({ node: tree[i], path: [] });
  while (stack.length) {
    const { node, path } = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const next = [...path, node.entry];
    if (node.entry && node.entry.id === leafId) return next;
    const kids = node.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], path: next });
  }
  return [];
}

async function refreshStats() {
  try {
    const d = await rpc({ type: 'get_session_stats' });
    const cost = d && d.cost && d.cost.total != null ? Number(d.cost.total) : null;
    $('stat-cost').textContent = cost != null
      ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`
      : '';
    let cu = d && d.contextUsage;
    const rawTokens = cu && cu.tokens != null ? cu.tokens : null;
    // While a turn is in flight the live number is anchored to the last real
    // count; let that anchor advance as pi reports usage between messages.
    if (S.isStreaming && rawTokens != null) {
      S.ctxBaseTokens = Math.max(S.ctxBaseTokens || 0, rawTokens);
    }
    // The 1s poll would otherwise pull the ring back to a stale base every tick
    // (the "jumping back" sawtooth), so the displayed count only climbs while a
    // turn is in flight and the authoritative value settles it at the end.
    if (S.isStreaming && cu && cu.tokens != null && S.ctxDisplayTokens != null && cu.tokens < S.ctxDisplayTokens) {
      cu = { ...cu, tokens: S.ctxDisplayTokens, percent: cu.contextWindow ? (S.ctxDisplayTokens / cu.contextWindow) * 100 : null };
    }
    setCtxRing(cu);
  } catch { /* ignore */ }
  updateTotals();
}

/* context-usage progress ring + "[used/max]ctx" label.
 * cu = { tokens, contextWindow, percent } from get_session_stats. After a
 * compaction the agent reports tokens:null until the next LLM response, in
 * which case the ring and label show a dash instead of a stale number.
 * While the model streams, liveCtxRing() feeds an estimate on top of the last
 * authoritative number so the ring fills in real time. */
function setCtxRing(cu, store = true) {
  if (store) S.ctxStats = cu && cu.tokens != null && cu.contextWindow ? { ...cu } : null;
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
    wrap.classList.remove('warn', 'critical');
    if (label) label.textContent = '–';
    S.ctxDisplayTokens = null;
    return;
  }
  const p = cu.percent != null
    ? Math.max(0, Math.min(100, cu.percent))
    : Math.max(0, Math.min(100, (tokens / max) * 100));
  S.ctxDisplayTokens = tokens;
  fg.setAttribute('stroke-dasharray', `${(C * p / 100).toFixed(1)} ${C.toFixed(1)}`);
  txt.textContent = p >= 10 ? String(Math.round(p)) : p.toFixed(1);
  wrap.title = `Context: ${formatTok(tokens)} / ${formatTok(max)} tokens (${p.toFixed(1)}%)`;
  wrap.classList.toggle('warn', p >= 75 && p < 90);
  wrap.classList.toggle('critical', p >= 90);
  if (label) label.textContent = `[${formatTok(tokens)}/${formatTok(max)}ctx]`;
}

/* Estimate the in-flight context growth (≈4 chars/token) and add it to the
 * last authoritative stats so the ring climbs while the model writes. The
 * base is the high-water mark, not the raw authoritative number: when a new
 * assistant message starts its estimate restarts at 0, and using the raw
 * base would visibly snap the ring back down. */
/* Character count of a message's content, mirroring pi's own estimator
 * (text + thinking + tool-call name and arguments). */
function messageChars(m) {
  if (!m || !Array.isArray(m.content)) return 0;
  let chars = 0;
  for (const block of m.content) {
    if (block.type === 'text' && block.text) chars += block.text.length;
    else if (block.type === 'thinking' && block.thinking) chars += block.thinking.length;
    else if (block.type === 'toolCall') chars += (block.name || '').length + JSON.stringify(block.arguments || {}).length;
  }
  return chars;
}

/* Total tokens a usage record implies - the same sum pi's
 * calculateContextTokens() does (totalTokens when the provider sends it). */
function usageContextTokens(u) {
  if (!u) return null;
  if (u.totalTokens) return u.totalTokens;
  const sum = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  return sum > 0 ? sum : null;
}

/* The context ring during a turn.
 *
 * Prefer real numbers: once the provider reports usage for the message in
 * flight, its prompt count is the context, so base + output is exact (pi will
 * report the same value when the message ends). Only while no usage has
 * arrived yet do we fall back to an estimate, and that estimate is calibrated
 * from the tokens-per-character the session has actually shown so far instead
 * of a fixed chars/4 guess. Both paths are clamped so the ring never walks
 * backwards mid-turn. */
function liveCtxRing(estimatedExtra) {
  if (!S.ctxStats) return;
  const b = S.ctxStats;
  let tokens;
  const real = usageContextTokens(S.live && S.live.lastUsage);
  if (real != null) {
    tokens = Math.max(real, S.ctxBaseTokens || 0, S.ctxDisplayTokens || 0);
  } else {
    const estimate = (S.ctxBaseTokens != null ? S.ctxBaseTokens : (b.tokens || 0)) + (estimatedExtra || 0);
    tokens = Math.max(estimate, S.ctxDisplayTokens || 0);
  }
  setCtxRing({ ...b, tokens, percent: b.contextWindow ? (tokens / b.contextWindow) * 100 : null }, false);
}

/* Tokens per character, measured from messages that already have real usage.
 * Used only for the first moments of a message, before usage arrives. */
function noteTokenRatio(usage, chars) {
  if (!usage || !chars || chars < 200) return;
  const out = usage.output || 0;
  if (!out) return;
  const ratio = out / chars;
  if (!(ratio > 0.05 && ratio < 2)) return;   // nonsense values stay out
  S.tokPerChar = S.tokPerChar ? S.tokPerChar * 0.7 + ratio * 0.3 : ratio;
}

/* session totals (↑ read / ↓ write) summed from assistant message usage */
function updateTotals(extraUsage) {
  const read = S.totals.read + ((u) => u ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0)(extraUsage);
  const write = S.totals.write + (extraUsage ? (extraUsage.output || 0) : 0);
  $('stat-tokens').textContent = `↑ ${formatTok(read) ?? 0} · ↓ ${formatTok(write) ?? 0}`;
}

/* ───────────────────────── chat rendering ───────────────────────── */

function atBottom(slack = 60) {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < slack;
}

/* Where does a transcript node go? Normally the chat. While another session is
 * on screen the agent's own output must not be mixed into it - that is why a turn
 * running in the background used to appear in whatever session you were reading.
 * It waits in a detached fragment until you switch back. transcriptTarget is set
 * while a transcript is rebuilt for display, so re-rendering the session you are
 * looking at still lands in the chat. */
let transcriptTarget = null;
function transcriptHost() {
  if (transcriptTarget) return transcriptTarget;
  if (!S.viewSession) return chat;
  const keep = S.liveDetached && S.liveDetached.frag ? S.liveDetached.frag : document.createDocumentFragment();
  S.liveDetached = { path: S.state.sessionFile, frag: keep };
  return keep;
}

function scrollBottom(force) {
  if (!force && transcriptTarget && transcriptTarget !== chat) return; // nothing was added to what you see

  if (!force && S.liveDetached) return; // the live view is parked; don't scroll the visible session
  if (!force && S.userScrolling) return; // never pin from under an active wheel/touch gesture
  if (force || S.stickToBottom) {
    lastProgrammaticScroll = Date.now();
    chat.scrollTop = chat.scrollHeight;
  }
}
let lastProgrammaticScroll = 0;
let userScrollIdle = 0;
chat.addEventListener('scroll', () => {
  // Only an explicit wheel/touch gesture is trusted as "the user left the
  // bottom". A scroll event that lands just after we pinned is normally the
  // browser reacting to content being inserted above the viewport (the chat
  // grows between our pin and the next layout pass), and treating that as a
  // user scroll is what stopped auto-follow when a thinking block or tool card
  // appeared mid-turn. Real gestures set S.userScrolling and are always
  // honoured, so the guard can be strict here.
  if (!S.userScrolling && Date.now() - lastProgrammaticScroll < 250) return;
  S.stickToBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
});
/* Re-pin once the newly inserted content has been laid out. scrollHeight read
 * in the same frame as an insert is stale, so the first pin can land short and
 * leave the view a few pixels off the bottom. */
function pinSoon() {
  if (!S.stickToBottom || S.userScrolling || S.liveDetached) return;
  requestAnimationFrame(() => {
    if (S.stickToBottom && !S.userScrolling && !S.liveDetached) scrollBottom();
  });
}
/* Explicit intent beats the guard above: a wheel-up or a touch drag is
 * unambiguous, so stop pinning before the browser even fires the scroll event.
 * Scrollbar drags are covered by the "dist < 4" check in the scroll handler. */
chat.addEventListener('wheel', (e) => {
  if (e.deltaY < 0) S.stickToBottom = false;
  else if (atBottom()) S.stickToBottom = true;
  S.userScrolling = true;
  clearTimeout(userScrollIdle);
  userScrollIdle = setTimeout(() => {
    S.userScrolling = false;
    if (atBottom()) S.stickToBottom = true; // settled back at the bottom → follow again
  }, 180);
}, { passive: true });
chat.addEventListener('touchstart', () => { S.userScrolling = true; }, { passive: true });
chat.addEventListener('touchmove', () => { S.stickToBottom = atBottom(); }, { passive: true });
chat.addEventListener('touchend', () => {
  S.userScrolling = false;
  S.stickToBottom = atBottom();
}, { passive: true });

function messageBlock(content) {
  // user message content may be a string or a block array
  if (typeof content === 'string') return { text: content, images: [] };
  const blocks = Array.isArray(content) ? content : [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    images: blocks.filter((b) => b.type === 'image'),
  };
}

/* ── profile image + manual crop ──────────────────────────────────────────
 * The avatar and the background can be a still image, a GIF or a video, and
 * either can be panned and zoomed by hand (openCropper). object-position pans
 * and transform: scale() zooms about the centre - the crop stage, the chat
 * avatar and the background all compose the same way, so the preview in the
 * cropper is what you get. */
const VIDEO_SRC = /\.(mp4|webm|mov|m4v|ogv|mkv)([?#]|$)/i;
const IMAGE_SRC = /\.(png|jpe?g|gif|webp|avif|bmp|svg)([?#]|$)/i;
function isVideoSrc(src) {
  return /^data:video\//i.test(src || '') || VIDEO_SRC.test(src || '');
}

function mediaNode(src, cls) {
  if (!src) return null;
  let node;
  if (isVideoSrc(src)) {
    node = el('video', cls);
    node.muted = true; node.loop = true; node.autoplay = true; node.playsInline = true;
    node.setAttribute('playsinline', '');
  } else {
    node = el('img', cls);
  }
  node.src = src;
  return node;
}

/* Old object-position crops are converted by normalizeCrop; the real
definitions live with the cropper. */

/* Profile image for the chat header, the sidebar and the settings preview.
 * There is no built-in default: with no image set, only the name is shown. */
function avatarNode(sizeClass) {
  if (!SET.avatar) return null;
  const wrap = el('span', `avatar-wrap${sizeClass ? ' ' + sizeClass : ''}`);
  const node = attachCrop(mediaNode(SET.avatar, 'avatar'), SET.avatarCrop, 1);
  wrap.appendChild(node);
  return wrap;
}

/* Re-render every avatar after the image, its crop or its size changes. */
function refreshAvatars() {
  document.querySelectorAll('.msg.assistant .who').forEach((who) => {
    const old = who.querySelector('.avatar-wrap');
    if (old) old.remove();
    const node = avatarNode();
    if (node) who.insertBefore(node, who.firstChild);
  });
  const side = $('sidebar-avatar');
  if (side) {
    const node = avatarNode();
    if (node) { side.replaceChildren(...node.childNodes); side.hidden = false; }
    else { side.replaceChildren(); side.hidden = true; }
  }
  const prev = $('set-avatar-preview');
  if (prev) {
    // Only the user's own image here, so "clear" visibly clears it (the app
    // icon fallback in the RN shell is not something you can crop or delete).
    if (SET.avatar) {
      const node = avatarNode();
      prev.replaceChildren(...node.childNodes);
      prev.style.visibility = 'visible';
    } else {
      prev.replaceChildren();
      prev.style.visibility = 'hidden';
    }
  }
}

function makeMsgShell(role, who) {
  const root = el('div', `msg ${role}`);
  const head = el('div', 'who');
  if (role.includes('assistant')) {
    const av = avatarNode();
    if (av) head.appendChild(av);
    head.appendChild(el('span', 'agent-name-label', SET.agentName || 'pi'));
    head.appendChild(el('span', 'who-text', ` · ${who}`));
  } else {
    head.appendChild(el('span', 'who-text', who));
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

/* Stamp fork ids onto the rendered user rows. Freshly sent rows cannot be
 * matched when they are drawn (their entry does not exist yet), so this runs
 * again whenever a turn settles: it walks the rows in order against the current
 * entry list and rewrites the ids, which makes every turn - including the very
 * first one - forkable from its right-click menu. */
async function stampForkIds() {
  if (S.viewSession) return;   // a read-only view already carries entry ids
  await refreshForkable().catch(() => {});
  resetForkQueue();
  document.querySelectorAll('#chat .msg.user').forEach((row) => {
    const text = row._msg ? messageBlock(row._msg.content).text : '';
    const fk = takeForkable(text);
    if (fk) {
      row.dataset.fork = fk.entryId;
      row.dataset.forktext = String(fk.text || '').slice(0, 300);
    } else {
      delete row.dataset.fork;
      delete row.dataset.forktext;
    }
  });
}

/* pi's user messages and the forkable list are both in order, so pair them up as
 * the transcript renders; identical texts then keep working. The list comes from
 * get_entries, not get_fork_messages: get_entries keeps pre-compaction history
 * and abandoned branches, so an old message - or one before the last compaction
 * - is still forkable instead of only the tail of the session. */
let forkQueue = [];
function resetForkQueue() { forkQueue = (S.forkEntries || []).map((f) => ({ ...f, used: false })); }
function takeForkable(text) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const t = norm(text);
  let hit = forkQueue.find((f) => !f.used && norm(f.text) === t);
  if (!hit) hit = forkQueue.find((f) => !f.used);
  if (hit) hit.used = true;
  return hit || null;
}

function renderUserMessage(msg) {
  const { text, images } = messageBlock(msg.content);
  const { root, tools, bubble } = makeMsgShell('user', `you · ${timeStr(msg.timestamp)}`);
  root._msg = msg;
  // Fork entry for this turn. A session read from disk carries its entry id;
  // for the agent's own session it is matched from the entry list. A row that
  // was just sent by this window is skipped: it is not in the file yet, so it
  // has no entry to point at, and consuming one would shift every later match.
  const fk = msg.entryId ? { entryId: msg.entryId } : (msg.__live ? null : takeForkable(text));
  if (fk) { root.dataset.fork = fk.entryId; root.dataset.forktext = text.slice(0, 300); }
  addCopyButton(tools, () => text);
  // fork index is (re)written onto the element by refreshMessages; read it at click time
  addToolButton(tools, 'edit', 'Edit & resend (forks the session from here)',
    () => startEdit(msg, root.dataset.forkIdx));

  if (images.length) {
    for (const im of images) {
      const img = el('img', 'msg-img');
      const dataUrl = `data:${im.mimeType || 'image/png'};base64,${im.data}`;
      lazySrc(img, dataUrl);
      img.onclick = () => zoomImage(img.dataset.src || dataUrl);
      bubble.appendChild(img);
    }
  }
  if (text) {
    const body = el('div', 'md');
    body.innerHTML = renderMarkdown(text).replace(/^<p>/, '').replace(/<\/p>$/, '');
    bubble.appendChild(body);
  }
  transcriptHost().appendChild(root);
  scrollBottom();
}

/* Estimated written tokens for a live message, used while streaming and as a
 * fallback when the provider never reports usage. */
function estWriteTokens(L) {
  if (!L) return 0;
  return Math.round((L.text.length + L.thinking.length) / 4);
}

/* Remember how long a message took so a later re-render (tool cards arriving,
 * a session re-read, a page reload) keeps the tokens/sec figure instead of
 * silently dropping it. Keyed by the message timestamp pi stores. */
function rememberTiming(msg, timing) {
  const key = msg && (msg.timestamp != null ? `t${msg.timestamp}` : (msg.id ? `i${msg.id}` : null));
  if (key && timing) S.msgTiming.set(key, timing);
  return timing;
}

function timingFor(msg, timing) {
  if (timing && (timing.elapsedSec || timing.prefillSec || timing.est)) {
    return rememberTiming(msg, timing);
  }
  const key = msg && (msg.timestamp != null ? `t${msg.timestamp}` : (msg.id ? `i${msg.id}` : null));
  if (key && S.msgTiming.has(key)) return S.msgTiming.get(key);
  return timing || null;
}

/* Messages read back from a session file have no live timings. The gap to the
 * previous message is the turn's duration, which is enough to show a rate - it
 * includes the prompt read, so the figure is a little conservative. */
function noteHistoryTiming(msg, prevTs) {
  const key = msg && msg.timestamp != null ? `t${msg.timestamp}` : null;
  if (!key || S.msgTiming.has(key)) return;
  if (prevTs == null || msg.timestamp == null) return;
  const sec = (msg.timestamp - prevTs) / 1000;
  if (sec > 0.05 && sec < 3600) S.msgTiming.set(key, { elapsedSec: sec, prefillSec: null });
}

function renderAssistantMessage(msg, timing) {
  timing = timingFor(msg, timing);
  const { root, tools, bubble } = makeMsgShell('assistant', timeStr(msg.timestamp));
  root._msg = msg;
  const textBlocks = [];
  let stats = usageStats(msg.usage, timing && timing.elapsedSec, timing && timing.prefillSec);
  if (!stats && timing && timing.est) stats = estStatsText(timing.est, timing.elapsedSec);
  if (stats) {
    const s = el('span', 'agent-stats', ` (${stats})`);
    s.title = (msg.usage
      ? 'token usage: input+cache read / output written'
      : 'estimated token usage - this provider did not report any') +
      (timing && timing.elapsedSec ? ` over ${timing.elapsedSec.toFixed(1)}s of streaming` : '');
    // Stats before the action buttons: "Pi · 04:30 PM (↑ 43.6K read · ↓ 523 write) [copy] [speak]"
    root.querySelector('.who').insertBefore(s, tools);
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
      // A call can still be executing when its assistant message is finalised
      // (message_end arrives before the tool runs), and finalizeLive re-renders
      // the message from history here. Keep such a card running, timer and all,
      // instead of showing a finished-looking card for a command that is
      // literally still executing.
      const prev = S.toolCards.get(block.id);
      const wasRunning = !!(prev && prev._timer);
      const card = makeToolCard(block.name, { toolCallId: block.id, state: wasRunning ? 'running' : 'done' });
      if (wasRunning) {
        clearInterval(prev._timer);
        card._start = prev._start;
        card._timeoutMs = prev._timeoutMs || 0;
        startCardTimer(card);
      }
      noteToolTimeout(card, block.arguments);
      fillToolBody(card, block.name, block.arguments);
      bubble.appendChild(card.card);
      S.toolCards.set(block.id, card);
    }
  }
  if (!bubble.childNodes.length) bubble.appendChild(el('div', 'md', '(empty message)'));
  transcriptHost().appendChild(root);
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

/* Three dots that bob in a wave. Used by the live message header and by the
 * "running" label on a tool card - the text itself deliberately stays still. */
function makeDots(cls) {
  const dots = el('span', cls || 'streaming-dots');
  for (let i = 0; i < 3; i++) dots.appendChild(el('span', 'dot', '.'));
  return dots;
}

/* Put a tool card back into its running state (the label is a bare "running"
 * with the animated dots after it, so only the dots move). */
function setCardRunning(card) {
  if (!card) return;
  const label = card.stateEl.querySelector('.tool-state-label');
  if (label) label.textContent = 'running';
  else card.stateEl.textContent = 'running';
  if (!card.stateEl.querySelector('.streaming-dots')) card.stateEl.appendChild(makeDots());
  card.stateEl.className = 'tool-state running';
}

function makeToolCard(name, opts = {}) {
  const card = el('div', `tool-card${name === 'bash' ? ' bash-card' : ''}`);
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'tool-name', `${name}`));
  const state = opts.state || 'running';
  // finished cards keep their colour too: the rebuilt-from-history cards used to
  // come back with no state class at all, so a done call lost its green label
  const stateCls = state === 'running' ? ' running' : (state === 'done' || state === 'error' ? ` ${state}` : '');
  const stateEl = el('span', `tool-state${stateCls}`);
  stateEl.appendChild(el('span', 'tool-state-label', state));
  if (state === 'running') stateEl.appendChild(makeDots());
  head.appendChild(stateEl);
  const timerEl = el('span', 'tool-timer hidden');
  head.appendChild(timerEl);
  const body = el('div', 'tool-body hidden');
  head.onclick = () => body.classList.toggle('hidden');
  card.append(head, body);
  return { card, head, body, stateEl, timerEl, _timer: null, _start: 0, _running: false, _timeoutMs: 0 };
}

/* pi's bash tool takes `timeout` in seconds; remember it so the card can count
 * down instead of just counting up. */
function noteToolTimeout(card, args) {
  if (!card || !args || typeof args !== 'object') return;
  const t = args.timeoutSeconds != null ? args.timeoutSeconds
    : (args.timeout_ms != null ? Number(args.timeout_ms) / 1000
      : (args.timeoutMs != null ? Number(args.timeoutMs) / 1000 : args.timeout));
  const secs = Number(t);
  if (Number.isFinite(secs) && secs > 0) card._timeoutMs = secs * 1000;
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
    stopCardTimer(card, msg.isError ? 'error' : 'done');
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
    transcriptHost().appendChild(root);
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
  transcriptHost().appendChild(root);
  scrollBottom();
}

/* The compaction summary message (role: "compactionSummary") marks where the old
 * history was compressed into a summary.
 *
 * It is deliberately NOT rendered inline where it sits in the session order:
 * pi rebuilds the context as [compaction summary, kept entries…], so the marker
 * lands at the very TOP of the transcript — hundreds of messages above the
 * viewport. The user saw the live "compacting…" block appear, then vanish, with
 * nothing at the bottom to show for it.
 *
 * Instead the newest compaction is pinned to the END of the chat (right where
 * the live block was), so it is always visible and its summary expandable.
 * Older compactions still render inline so scrolling back stays accurate. */
function renderCompactionSummary(msg, extra) {
  transcriptHost().appendChild(buildCompactionSummary(msg, extra));
}

/* Build the "conversation compacted" marker WITHOUT inserting it, so callers can
 * put it exactly where the compaction happened. */
function buildCompactionSummary(msg, extra) {
  const live = !!(extra && extra.live);
  const root = el('div', 'msg compaction');
  const who = el('div', 'who');
  const before = msg.tokensBefore != null ? `${formatTok(msg.tokensBefore)} tok` : 'context';
  const after = extra && extra.estimatedTokensAfter != null
    ? ` → ${formatTok(extra.estimatedTokensAfter)} tok` : '';
  who.textContent = `conversation compacted · ${before}${after}`;
  if (extra && extra.count > 1) {
    const badge = el('span', 'compaction-count', `${extra.count}✕`);
    badge.title = `${extra.count} compactions in this session`;
    who.appendChild(badge);
  }
  const detail = el('details', 'compaction-detail');
  detail.appendChild(el('summary', null, 'show compacted summary'));
  const body = el('div', 'md compaction-body');
  body.innerHTML = renderMarkdown(msg.summary || '');
  detail.appendChild(body);
  root.append(who, detail);
  return root;
}

/* Transcript images are inline data: URLs, and a long session with a few dozen
 * of them used to keep every one of them decoded for the life of the page -
 * hundreds of megabytes. The source waits in a data attribute and the element
 * only gets it while it is near the viewport; far away the bitmap is dropped
 * again, so scrolling back and forth reloads instead of hoarding. */
let mediaNear = null;
let mediaFar = null;
function lazySrc(node, src) {
  if (!node || !src) return node;
  node.dataset.src = src;
  node.decoding = 'async';
  node.setAttribute('loading', 'lazy');
  if (!mediaNear) {
    mediaNear = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = e.target;
        const want = n.dataset.src;
        if (!e.isIntersecting || !want) continue;
        if (n.getAttribute('src') !== want) n.setAttribute('src', want);
      }
    }, { rootMargin: '1200px 0px' });
    mediaFar = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = e.target;
        if (e.isIntersecting) continue;
        if (n.tagName === 'VIDEO') { try { n.pause(); } catch { } }
        n.removeAttribute('src');
        if (n.tagName === 'VIDEO') { try { n.load(); } catch { } }
      }
    }, { rootMargin: '3000px 0px' });
  }
  mediaNear.observe(node);
  mediaFar.observe(node);
  return node;
}

/* Live "compacting…" marker, shown the moment compaction_start arrives so the
 * user sees compaction happen in real time (with an elapsed timer). Replaced
 * by renderCompactionBlock() when compaction_end arrives. */
function renderCompactionLive() {
  const root = el('div', 'msg compaction compacting');
  const who = el('div', 'who');
  const spin = el('span', 'compaction-spin');
  who.appendChild(spin);
  who.appendChild(document.createTextNode(' compacting conversation… '));
  const timer = el('span', 'tool-timer');
  who.appendChild(timer);
  root.appendChild(who);
  transcriptHost().appendChild(root);
  const start = Date.now();
  const t = setInterval(() => { timer.textContent = fmtElapsed(Date.now() - start); }, 500);
  if (S.stickToBottom) scrollBottom();
  return { root, t };
}
function removeCompactionLive() {
  if (S.compactionLive) {
    clearInterval(S.compactionLive.t);
    S.compactionLive.root.remove();
    S.compactionLive = null;
  }
}

/* Live compaction marker, rendered the moment compaction_end arrives so the
 * event is visible immediately (the session history only contains the marker
 * after the next full re-render, which happens on agent_settled). */
function renderCompactionBlock(result, reason) {
  removeCompactionLive();
  for (const old of chat.querySelectorAll('.msg.compaction.pinned')) old.remove();
  const root = el('div', 'msg compaction pinned');
  const who = el('div', 'who');
  const before = result.tokensBefore != null ? `${formatTok(result.tokensBefore)} tok` : 'context';
  const after = result.estimatedTokensAfter != null ? ` → ${formatTok(result.estimatedTokensAfter)} tok` : '';
  who.textContent = `conversation compacted · ${before}${after}${reason ? ` · ${reason}` : ''}`;
  const detail = el('details', 'compaction-detail');
  detail.appendChild(el('summary', null, 'show compacted summary'));
  const body = el('div', 'md compaction-body');
  body.innerHTML = renderMarkdown(result.summary || '');
  detail.appendChild(body);
  root.append(who, detail);
  transcriptHost().appendChild(root);
  if (S.stickToBottom) scrollBottom();
}

// Read a session transcript from the bridge (messages + the compaction
// entries, which are not messages and so are absent from get_messages).
/* pi writes timestamps as ISO strings; every comparison below is numeric, and
 * Number("2026-09-20T...") is NaN - which is why every compaction marker landed
 * at the top of the transcript instead of where it happened. */
function tsMs(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchSession(sessionPath) {
  const r = await fetch(`/api/session-messages?path=${encodeURIComponent(sessionPath)}`);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `failed (${r.status})`);
  return {
    messages: d.messages || [],
    compactions: (d.compactions || []).map((c) => ({
      ...c,
      at: tsMs(c.timestamp),
    })),
  };
}

async function refreshMessages() {
  if (!S.viewSession) await refreshForkable().catch(() => {});
  resetForkQueue();
  let msgs;
  let fileMarks = [];
  if (S.viewSession) {
    // Viewing another session while the agent runs in its own: read it
    // read-only from the file (the get_messages RPC only knows the agent's
    // own session).
    const d = await fetchSession(S.viewSession);
    msgs = d.messages;
    fileMarks = d.compactions;
  } else {
    const d = await rpc({ type: 'get_messages' });
    const rpcMsgs = asArray(d, 'messages');
    msgs = rpcMsgs;
    // get_messages hands back pi's *current context*. Once a compaction has run
    // that is the summary plus whatever came after it, so scrolling up showed
    // compaction entries and none of the conversation they replaced. The session
    // file keeps the whole log - prefer it whenever it is longer, and append
    // anything pi holds that has not been written to it yet (a message sent
    // seconds ago).
    if (S.state.sessionFile) {
      try {
        const f = await fetchSession(S.state.sessionFile);
        fileMarks = f.compactions;
        if (f.messages.length > rpcMsgs.length) {
          const newest = f.messages.reduce((acc, m) => Math.max(acc, Date.parse((m && m.timestamp) || '') || 0), 0);
          const pendingMsgs = rpcMsgs.filter((m) => (Date.parse((m && m.timestamp) || '') || 0) > newest);
          msgs = [...f.messages, ...pendingMsgs];
        }
      } catch { /* no file to read: keep the RPC view */ }
    }
  }
  // Markers we watched happen in this page session, plus the ones already in
  // the file. Deduped by summary text so a watched compaction is not doubled.
  const marks = [...S.compactionMarks];
  const markSeen = new Set(marks.map((k) => k.summary));
  for (const k of fileMarks) if (k.summary && !markSeen.has(k.summary)) marks.push(k);
  for (const m of msgs) {
    if (m && m.timestamp != null && typeof m.timestamp !== 'number') {
      const n = Date.parse(m.timestamp);
      if (Number.isFinite(n)) m.timestamp = n;
    }
  }
  // Keep the reading position (distance from the bottom) across the re-render.
  const distFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  chat.innerHTML = '';
  if (!S.viewSession) {
    // Only the agent's own session owns the live tool cards; a read-only
    // render of another session must not touch them. Normally this re-render
    // wipes the cards (they are rebuilt from the message content below), but
    // if a live message is in flight its cards must survive: they keep
    // receiving tool_execution_update/end events and are re-attached with
    // S.live below.
    const liveCards = S.live
      ? [...S.toolCards.entries()].filter(([, c]) => S.live.root.contains(c.card))
      : [];
    const liveIds = new Set(liveCards.map(([id]) => id));
    // Cards whose tool is still executing must keep their running state: they
    // are rebuilt from the message below, and this loop used to mark every card
    // that was not part of the live message as "done" - so a long command could
    // show done while it was still running.
    const keepCards = new Map();
    for (const [id, card] of S.toolCards) {
      if (liveIds.has(id)) continue;
      if (card._running) { keepCards.set(id, card); continue; }
      if (card._timer) stopCardTimer(card, 'done');
    }
    S.toolCards.clear();
    for (const [id, card] of liveCards) S.toolCards.set(id, card);
    for (const [id, card] of keepCards) S.toolCards.set(id, card);
    // Keep the live "compacting…" marker through a re-render: a compaction that
    // starts after the turn settled had its marker wiped here, so the status
    // only showed up once it was already over.
    if (S.compacting) {
      if (S.compactionLive) chat.appendChild(S.compactionLive.root);
    } else {
      removeCompactionLive();
    }
  }
  // session token totals summed from per-message usage
  let read = 0;
  let write = 0, prevTs = null;
  // A session with thousands of messages (and images in them) freezes the tab
  // while every row is built. Counters still cover all of it, but only the
  // newest slice is rendered; the rest loads on demand from the button below.
  if (S.windowFor !== S.state.sessionFile) { S.windowFor = S.state.sessionFile; S.historyWindow = 400; }
  const win = Math.max(80, S.historyWindow || 400);
  const windowed = msgs.length > win;
  const skipped = new Set(windowed ? msgs.slice(0, msgs.length - win) : []);
  transcriptTarget = chat;   // this rebuild is for the transcript on screen
  for (const m of msgs) {
    // Totals count every message, rendered or not.
    if (m.usage) {
      read += (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
      write += m.usage.output || 0;
    }
    if (skipped.has(m)) continue;
    const firstNew = chat.children.length;
    if (m.role === 'user') renderUserMessage(m);
    else if (m.role === 'assistant') {
      noteHistoryTiming(m, prevTs);
      renderAssistantMessage(m);
    }
    else if (m.role === 'toolResult') renderToolResult(m);
    else if (m.role === 'bashExecution') renderBashExecution(m);
    else if (m.role === 'compactionSummary') {
      // In place, in order - a compaction marker belongs at the point in the
      // conversation where it happened, and it scrolls away with it. Pinning the
      // newest one to the bottom left a marker permanently on screen.
      renderCompactionSummary(m);
    }
    // Stamp whatever node(s) this message produced, so a compaction marker can
    // be anchored to a point in time instead of a shifting position.
    if (m.timestamp != null) {
      for (let i = firstNew; i < chat.children.length; i++) chat.children[i].dataset.ts = String(m.timestamp);
      prevTs = m.timestamp;
    }
  }
  transcriptTarget = null;
  // A compaction marker sits at the end of the transcript, so typing or a new
  // answer never pushes it out of sight.
  if (!S.viewSession) {
    // A compaction we watched happen is re-placed at the point it happened,
    // anchored by timestamp. Its entry is in the session file too once the turn
    // is saved, and that copy is rendered in order above, so skip those.
    const inFile = new Set(msgs.filter((m) => m.role === 'compactionSummary' && m.summary).map((m) => m.summary));
    const plain = [...chat.querySelectorAll('.msg:not(.compaction)')];
    for (const k of marks) {
      if (k.summary && inFile.has(k.summary)) continue;
      const at = tsMs(k.at);
      let target = null;
      let firstTs = 0;
      for (const n of plain) {
        const ts = Number(n.dataset.ts) || 0;
        if (!firstTs && ts) firstTs = ts;
        if (ts && at && ts <= at) target = n;
      }
      const node = buildCompactionSummary(k, { count: marks.length });
      // Before the first rendered message only if it really is older than it;
      // otherwise it belongs after the newest content, not at the top.
      if (target) target.after(node);
      else if (at && firstTs && at < firstTs) plain[0].before(node);
      else chat.appendChild(node);
    }
    // A compaction still in flight keeps its "compacting…" indicator: the
    // re-render above wiped the DOM node it lived in.
    if (S.compacting && !S.compactionLive) S.compactionLive = renderCompactionLive();
  }
  // Totals are high-water marks: a compaction removes the older messages from
  // the session file, and recomputing the sum from what is left made the read /
  // write counters drop right after a compaction. They only reset when you
  // switch to another session.
  const base = S.sessionTotals && S.sessionTotals.path === S.state.sessionFile ? S.sessionTotals : null;
  const totals = {
    path: S.state.sessionFile,
    read: Math.max(read, (base && base.read) || 0),
    write: Math.max(write, (base && base.write) || 0),
  };
  S.sessionTotals = totals;
  S.totals = { read: totals.read, write: totals.write };
  updateTotals();
  // Older messages are only rendered on request.
  if (windowed) {
    const hidden = msgs.length - win;
    const more = el('div', 'load-older');
    const btn = el('button', 'btn small', `load ${hidden} older message${hidden > 1 ? 's' : ''}`);
    btn.onclick = () => {
      S.historyWindow = (S.historyWindow || win) + 400;
      const keep = chat.scrollHeight - chat.scrollTop;
      refreshMessages().then(() => {
        const c = $('chat');
        c.scrollTop = c.scrollHeight - keep;
      }).catch(() => {});
    };
    more.appendChild(btn);
    chat.insertBefore(more, chat.firstChild);
  }
  // The last turn's total belongs on the last message: bring it back after a
  // re-render (a settle, a reload, a session re-read).
  if (S.lastTurn && S.lastTurn.ms) {
    const bubbles = chat.querySelectorAll('.msg.assistant .bubble');
    const b = bubbles.length ? bubbles[bubbles.length - 1] : null;
    if (b) {
      b.querySelectorAll('.turn-timer').forEach((n) => n.remove());
      b.appendChild(el('div', 'turn-timer', `turn took ${fmtElapsed(S.lastTurn.ms)}`));
    }
  }
  // Re-wire fork indexes for user messages in order.
  const userEls = [...chat.querySelectorAll('.msg.user')];
  userEls.forEach((e, i) => e.dataset.forkIdx = String(i));
  // Fork ids belong to rows by position on the active branch, not by matching
  // message text - two turns with the same wording got each other's id, so a
  // fork was taken from the wrong turn. Re-stamp after every render.
  stampForkIds().catch(() => {});
  // Back on the agent's own session mid-stream: re-attach the in-flight live
  // message (it was parked in S.liveDetached while viewing elsewhere). Only
  // when the agent is still in the session the live view belongs to.
  if (!S.viewSession && S.liveDetached && S.live && S.liveDetached.path === S.state.sessionFile) {
    chat.appendChild(S.liveDetached.frag);
  }
  S.liveDetached = null;
  if (S.stickToBottom) scrollBottom(true);
  else chat.scrollTop = chat.scrollHeight - chat.clientHeight - distFromBottom;
}

/* Full-size view of an image. The old version reused the drag-and-drop overlay,
 * which is pointer-events: none, so it could never be closed. */
function zoomImage(src) {
  const ov = el('div', 'img-zoom');
  const img = el('img');
  img.src = src;
  const close = el('button', 'img-zoom-close', '✕');
  close.title = 'Close (Esc)';
  close.onclick = (e) => { e.stopPropagation(); ov.remove(); };
  ov.append(img, close);
  ov.onclick = (e) => { if (e.target !== img) ov.remove(); };
  const onKey = (e) => {
    if (!document.body.contains(ov)) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}

/* ───────────────────────── event stream ───────────────────────── */

function handleEvent(msg) {
  switch (msg.type) {
    case 'session_info_changed': {
      // pi emits this when a session is (re)named — keep the topbar in sync and
      // refresh the sidebar so a rename shows up there immediately.
      const name = (msg.name || '').trim();
      if (name) {
        const input = $('session-name');
        input.value = name;
        input.title = `${name} — click to rename`;
      }
      refreshSessions().catch(() => {});
      break;
    }
    case 'agent_start':
      S.isStreaming = true;
      // The turn clock starts here (and covers thinking, tool calls and waiting).
      // It used to be set in a second `case 'agent_start'` label further down -
      // dead code, because the first matching case wins, so every turn was
      // measured as 0.0s.
      S.turnStartTs = Date.now();
      updateStreamUi();
      autoOpenShortsIfEnabled();
      break;
    case 'agent_end':
      break;
    case 'agent_settled':
      if (msg.type === 'agent_settled') {
        S.isStreaming = false;
        autoCloseShortsIfOurs();
        // The turn total is stamped after the transcript has been finalised
        // below: stamping it here put the number into a bubble that finalizeLive()
        // then replaced, so the total never showed up.
        S.turnPendingStamp = true;
        // The turn is in the session file now: (re)attach fork ids to the rows.
        stampForkIds().catch(() => {});
        // After a compaction the session history no longer matches the chat
        // DOM (older messages were summarized away and the "compacted" marker
        // is missing) — re-render from the session so the marker shows up.
        if (S.compactionHappened) {
          S.compactionHappened = false;
          refreshMessages().catch(() => {});
        }
        // Threshold/manual compactions stop the agent; keep the task going.
        if (S.compactionNeedsContinue) {
          S.compactionNeedsContinue = false;
          maybeAutoContinue();
        }
      }
      updateStreamUi();
      if (msg.type === 'agent_end') {
        finalizeLive();
        refreshCommands().catch(() => {});   // extensions may register commands late
        refreshStats().catch(() => {});
        refreshForkable().catch(() => {});
        refreshSessions().catch(() => {});
      }
      // Now that the transcript is settled, write the total time the turn took
      // (and put the compaction marker back at the end of the list).
      if (S.turnPendingStamp) {
        S.turnPendingStamp = false;
        setTimeout(stampTurnTimer, 0);
      }
      // A compaction that never reported back would otherwise leave the status
      // bar saying "compacting…" for the rest of the session.
      if (S.compacting) {
        S.compacting = false;
        removeCompactionLive();
        clearCompactLabelSoon();
      }
      // Send the next message the user queued during compaction, now that the
      // agent is idle (agent_settled). No-op when the queue is empty.
      flushCompactionQueue();
      break;
    case 'message_start':
      // A turn that begins with a tool call may not fire agent_start in some
      // versions; make sure the clock is running either way.
      if (!S.turnStartTs) S.turnStartTs = Date.now();
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
        stopCardTimer(c, msg.isError ? 'error' : 'done');
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
      // Live "compacting…" block with an elapsed timer, removed on compaction_end.
      if (!S.compactionLive) S.compactionLive = renderCompactionLive();
      break;
    case 'compaction_end': {
      // Declared out here: these used to be consts inside the `else if (msg.result)`
      // block and read after it, so this handler threw a ReferenceError before it
      // could refresh - leaving "compacting…" in the status bar forever and the
      // compacted-to size nowhere.
      let before = null;
      let after = null;
      S.compacting = false;
      if (msg.aborted) {
        removeCompactionLive();
        clearCompactLabelSoon();
        toast('Compaction cancelled', 'warning');
      } else if (msg.errorMessage) {
        removeCompactionLive();
        clearCompactLabelSoon();
        toast(msg.errorMessage, 'error');
      } else if (msg.result) {
        before = msg.result.tokensBefore;
        after = msg.result.estimatedTokensAfter;
        toast(`Compacted: ${before != null ? formatTok(before) : '?'} → ${after != null ? formatTok(after) : '?'} tokens`);
        S.lastCompaction = msg.result;
        // Remember it so refreshMessages() can put the marker back where it
        // happened instead of re-appending it to the bottom every turn.
        if (!S.compactionMarks.some((k) => k.summary === msg.result.summary)) {
          S.compactionMarks.push({ ...msg.result, at: Date.now() });
        }
        renderCompactionBlock(msg.result, msg.reason);
        S.compactionHappened = true;
        // willRetry=true (overflow) → pi retries the prompt itself. A manual
        // /compact never auto-continues (the user asked for it, task was done).
        // Only auto-compactions (threshold/overflow without retry) need a nudge.
        if (!msg.willRetry && msg.reason !== 'manual') S.compactionNeedsContinue = true;
      } else {
        removeCompactionLive();
      }
      // Context is unknown to pi right after compaction (it reports tokens:null
      // until the next response), which left the ring showing a dash until the
      // session was switched. Show the estimated size the compaction itself
      // reported, then keep asking until pi has a real number.
      if (after != null) showCompactionEstimate(after);
      clearCompactLabelSoon();
      refreshStats().catch(() => {});
      scheduleStatsRetry();
      flushCompactionQueue();
      break;
    }
    default:
      break;
  }
}

/* live streaming render */
/* Total time the turn took, written inside the last message of that turn. It is
 * wall-clock time from agent_start to agent_settled, so tool calls and waiting
 * are included, not just the writing. */
function stampTurnTimer() {
  const start = S.turnStartTs;
  S.turnStartTs = null;
  if (!start) return;
  const ms = Date.now() - start;
  // Remembered so a later re-render (or a session reload) can put the total
  // back on the last message instead of losing it.
  S.lastTurn = { ms, ts: Date.now() };
  const stat = $('stat-turn');
  if (stat) {
    stat.textContent = `turn ${fmtElapsed(ms)}`;
    stat.title = `the last turn took ${fmtElapsed(ms)} (thinking, tool calls and waiting included)`;
    stat.classList.remove('live');
  }
  const bubbles = chat.querySelectorAll('.msg.assistant .bubble');
  const bubble = bubbles.length ? bubbles[bubbles.length - 1] : null;
  if (!bubble) return;
  bubble.querySelectorAll('.turn-timer').forEach((n) => n.remove());
  bubble.appendChild(el('div', 'turn-timer', `turn took ${fmtElapsed(ms)}`));
}

/* Live version while the turn is running: lives in the status bar (where the
 * total ends up) instead of inside the message being written. */
function startTurnTimer() {
  const stat = $('stat-turn');
  const started = S.turnStartTs || Date.now();
  if (!stat) return () => {};
  stat.classList.add('live');
  const tick = () => { stat.textContent = `turn ${fmtElapsed(Date.now() - started)}`; };
  tick();
  const t = setInterval(tick, 1000);
  return () => clearInterval(t);
}

function startLive() {
  const { root, tools, bubble } = makeMsgShell('assistant streaming', '…');
  addCopyButton(tools, () => S.live ? S.live.text : '');
  addSpeakButton(tools, () => stripMarkdown(S.live ? S.live.text : ''));
  // Copy/speak only make sense once the message is final — keep the buttons
  // hidden while streaming. finalizeLive() replaces this shell with the
  // rendered message, where they are visible again.
  tools.classList.add('pending');
  const md = el('div', 'md');
  bubble.appendChild(md);
  const statsEl = el('span', 'agent-stats');
  root.querySelector('.who').insertBefore(statsEl, tools);
  // The "..." dots bob up and down in a wave (each dot delayed) while the
  // agent generates/reads.
  const dots = el('span', 'streaming-dots');
  for (let i = 0; i < 3; i++) dots.appendChild(el('span', 'dot', '.'));
  root.querySelector('.who-text').replaceChildren(document.createTextNode(' · '), dots);
  const stopTurnTimer = startTurnTimer();
  // While another session is on screen the live message stays out of it: new
  // turns used to be appended to whatever transcript was open, so the agent
  // appeared to write into the session you were reading.
  transcriptHost().appendChild(root);
  S.live = { root, md, text: '', thinking: '', thinkingEl: null, caret: el('span', 'streaming-caret'),
    stopTurnTimer,
    toolByIndex: new Map(),   // contentIndex -> tool card while a call is streaming
    toolArgChars: new Map(),  // contentIndex -> argument characters streamed so far
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
  else if (ev.type === 'toolcall_start') {
    // pi streams tool calls keyed by contentIndex and only sends {type,
    // contentIndex} at the start — the id, name and arguments arrive with the
    // deltas/end (assistantMessageEvent.partial is stripped by the RPC layer).
    // Track the card by contentIndex so it can appear and grow while the model
    // is still writing the call, instead of popping in fully formed.
    if (L.toolByIndex.has(ev.contentIndex)) {
      // duplicate start for the same block — keep the card we already have
    } else {
      const card = makeToolCard(ev.toolName || 'tool', { toolCallId: ev.id || `stream-${ev.contentIndex}` });
      card.toolName = ev.toolName || '';
      card._rawArgs = '';
      card._contentIndex = ev.contentIndex;
      L.root.querySelector('.bubble').appendChild(card.card);
      startCardTimer(card);
      L.toolByIndex.set(ev.contentIndex, card);
      if (ev.id) S.toolCards.set(ev.id, card);
      pinSoon();   // a new card above the caret — keep following
    }
  }
  else if (ev.type === 'toolcall_delta') {
    // Stream the arguments as they are written (a `write` shows the file, a
    // `bash` shows the command) — this is the "tool call being generated".
    const c = (ev.contentIndex != null && L.toolByIndex.get(ev.contentIndex)) || (ev.id && S.toolCards.get(ev.id));
    if (c) {
      c._rawArgs = (c._rawArgs || '') + (ev.delta || ev.argumentsDelta || ev.partial || ev.partialArgs || '');
      const named = toolNameFromJson(c._rawArgs);
      if (named && named !== c.toolName) {
        c.toolName = named;
        c.card.querySelector('.tool-name').textContent = named;
      }
      c.body.classList.remove('hidden');
      c.body.textContent = liveToolPreview(c.toolName, c._rawArgs);
      if (!L.toolArgChars) L.toolArgChars = new Map();
      L.toolArgChars.set(ev.contentIndex, c._rawArgs.length);
      scrollBottom();
    }
  }
  else if (ev.type === 'toolcall_end' && ev.toolCall) {
    const byIndex = ev.contentIndex != null ? L.toolByIndex.get(ev.contentIndex) : null;
    const existing = byIndex || S.toolCards.get(ev.toolCall.id);
    if (existing) {
      // Reuse the card created by toolcall_start (it already has the live
      // preview and the elapsed timer) instead of appending a duplicate.
      existing.toolName = ev.toolCall.name;
      existing.card.querySelector('.tool-name').textContent = ev.toolCall.name;
      noteToolTimeout(existing, ev.toolCall.arguments);
      if (existing._running && existing._timeoutMs) restartCardTimer(existing);
      fillToolBody(existing, ev.toolCall.name, ev.toolCall.arguments);
      // Re-key to the real tool-call id so the tool_execution_* events (which
      // are keyed by it) find this card.
      if (existing._contentIndex != null) L.toolByIndex.delete(existing._contentIndex);
      existing.toolCallId = ev.toolCall.id;
      S.toolCards.set(ev.toolCall.id, existing);
    } else {
      const card = makeToolCard(ev.toolCall.name, { toolCallId: ev.toolCall.id });
      fillToolBody(card, ev.toolCall.name, ev.toolCall.arguments);
      L.root.querySelector('.bubble').appendChild(card.card);
      S.toolCards.set(ev.toolCall.id, card);
    }
  }
  renderLive();
}

/* The streamed argument JSON sometimes carries the tool name (providers differ);
 * pull it out early so the card can be labelled while it is still being written. */
function toolNameFromJson(raw) {
  const m = /"(?:name|tool|toolName|tool_name)"\s*:\s*"([A-Za-z0-9_.-]{1,40})"/.exec(raw || '');
  return m ? m[1] : null;
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
      pinSoon();   // the block is inserted above the caret — follow it
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
      stats = estStatsText(estWriteTokens(L), sec);
    }
    if (stats) L.statsEl.textContent = ` (${stats})`;
    // Live context ring: pi's last authoritative count + the in-flight message,
    // estimated the same way pi itself does (chars/4).
    liveCtxRing(liveExtraTokens());
    scrollBottom();
  });
}

/* Estimate the tokens the in-flight message will add, using the ratio the
 * session has actually shown (pi itself falls back to chars/4). */
function liveExtraTokens() {
  const L = S.live;
  if (!L) return 0;
  let chars = L.text.length + L.thinking.length;
  if (L.toolArgChars) for (const n of L.toolArgChars.values()) chars += n;
  const ratio = S.tokPerChar || 0.25;
  return Math.round(chars * ratio);
}

function finalizeLive(finalMsg) {
  if (S.live) {
    const L = S.live;
    if (L.stopTurnTimer) L.stopTurnTimer();
    const elapsedSec = (Date.now() - L.startTs) / 1000;
    const prefillSec = L.firstDeltaTs ? (L.firstDeltaTs - L.startTs) / 1000 : null;
    S.live.root.remove();
    S.live = null;
    if (S.liveDetached) {
      // Viewing another session: the final message is already in the session
      // file, so the read-only render will show it. Drop the live state; the
      // agent session's totals refresh when the user switches back.
    } else if (finalMsg && finalMsg.role === 'assistant') {
      const usage = finalMsg.usage || L.lastUsage;
      if (usage) {
        S.totals.read += (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
        S.totals.write += usage.output || 0;
        noteTokenRatio(usage, messageChars(finalMsg));
      }
      const timed = usage && !finalMsg.usage ? { ...finalMsg, usage } : finalMsg;
      // No usage from the provider (some endpoints never send it): keep the
      // estimated counter that was on screen while streaming, so the token rate
      // does not simply vanish when the turn ends.
      const timing = { elapsedSec, prefillSec };
      if (!usage) timing.est = estWriteTokens(L);
      rememberTiming(timed, timing);
      renderAssistantMessage(timed, timing);
      updateTotals();
      if (S.autoTts) {
        const text = (finalMsg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        if (text.trim()) speak(stripMarkdown(text));
      }
    } else {
      refreshMessages().catch(() => {});
    }
  }
  // Do NOT clear S.isStreaming here. finalizeLive() runs on every message_end
  // and turn_end -- including the user's own message -- and clearing it there
  // hid the Stop button the instant the first message ended, and made
  // sendPrompt() omit streamingBehavior, so pi rejected mid-turn sends instead
  // of steering them. The turn is only over at agent_settled (or agent_exit /
  // socket close).
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
    // It may have been rendered as "done" by the message finalise above; the
    // execution is starting right now, so put the running label back.
    setCardRunning(existing);
    noteToolTimeout(existing, msg.args);
    // With a timeout known, count down from the moment the command starts.
    if (existing._timeoutMs) restartCardTimer(existing);
    else startCardTimer(existing);
    return existing;
  }
  const card = makeToolCard(msg.toolName || msg.name || 'tool', { toolCallId: msg.toolCallId });
  card.toolName = msg.toolName || msg.name || '';
  card._rawArgs = '';
  noteToolTimeout(card, msg.args);
  fillToolBody(card, card.toolName, msg.args);
  startCardTimer(card);
  const parent = S.live ? S.live.root.querySelector('.bubble') : chat;
  parent.appendChild(card.card);
  S.toolCards.set(msg.toolCallId, card);
  scrollBottom();
  pinSoon();
  return card;
}

/* The ring right after a compaction: pi has no number yet, so show the estimate
 * the compaction reported instead of a dash. */
function showCompactionEstimate(tokens) {
  const win = (S.ctxStats && S.ctxStats.contextWindow) || (S.state && S.state.contextWindow) || null;
  if (!win) return;
  setCtxRing({ tokens, contextWindow: win, percent: Math.max(0, Math.min(100, (tokens / win) * 100)) });
}

/* pi only knows the new context size once it has answered something again, so
 * check a few times instead of leaving the estimate on screen forever. */
function scheduleStatsRetry() {
  [3000, 8000, 20000].forEach((ms) => setTimeout(() => { refreshStats().catch(() => {}); }, ms));
}

/* Put a real number back in the status bar in case the "compacting…" state is
 * left over (a compaction that was cancelled, failed, or whose end event never
 * arrived). Anything the ring has already shown is left alone. */
function clearCompactLabelSoon() {
  setTimeout(() => {
    const label = $('ctx-label');
    if (!label || label.textContent !== 'compacting…') return;
    label.textContent = '–';
    refreshStats().catch(() => {});
  }, 250);
}

function updateStreamUi() {
  // The Stop button appears next to the (always visible) Send button while the
  // agent is generating, so you can stop generation or steer/queue a message.
  $('btn-stop').classList.toggle('hidden', !S.isStreaming);
  setConn(S.isStreaming ? 'busy' : 'on');
  // Reset the ring's high-water mark on every streaming transition so the
  // final authoritative total can settle (even if the estimate overshot), and
  // remember where this turn started so the live number can be anchored to it.
  if (S.isStreaming && S.ctxBaseTokens == null) {
    S.ctxBaseTokens = (S.ctxStats && S.ctxStats.tokens) || 0;
  }
  S.ctxDisplayTokens = null;
  if (S.isStreaming) startCtxPoll(); else { stopCtxPoll(); S.ctxBaseTokens = null; }
  renderQueue();
  updateLiveDot();
  updateViewBanner();
}

// Banner shown while the user is viewing a session other than the agent's own.
function updateViewBanner() {
  const b = $('view-banner');
  if (!b) return;
  if (!S.viewSession) {
    b.classList.add('hidden');
    b.textContent = '';
    return;
  }
  const base = S.viewSession.split(/[\\/]/).pop();
  const s = (S.sessionsList || []).find((x) => x.path === S.viewSession || x.fileName === base);
  const name = (s && s.name) || base.replace(/\.jsonl$/, '');
  b.classList.remove('hidden');
  b.textContent = S.isStreaming
    ? `Viewing “${name}” — the agent is still running in its own session (green dot in the list) and keeps going in the background. `
    : `Viewing “${name}” — read-only. The agent is in its own session; click it in the list to switch back. `;
  const btn = el('button', 'btn small', 'switch back');
  btn.onclick = () => switchToSession(S.state.sessionFile);
  b.appendChild(btn);
}

/* Keep the green "live" dot in the session list in sync with streaming state
 * immediately. A full refreshSessions only runs on session changes or while
 * idle, so without this the dot would appear late or not at all mid-stream
 * (it used to only show up after a page reload). */
function updateLiveDot() {
  const list = $('session-list');
  if (!list) return;
  for (const item of list.querySelectorAll('.session-item.active')) {
    item.classList.toggle('live', S.isStreaming);
    const nameRow = item.querySelector('.s-name');
    if (!nameRow) continue;
    const dot = nameRow.querySelector('.live-dot');
    if (S.isStreaming && !dot) nameRow.prepend(el('span', 'live-dot', ''));
    else if (!S.isStreaming && dot) dot.remove();
  }
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

/* pi only auto-retries after an *overflow* compaction. After a *threshold*
 * (or manual) compaction it stops and waits for the next user message — even
 * when the task is clearly not done. Nudge it along automatically (once per
 * cooldown) so long tasks keep going. */
function maybeAutoContinue() {
  if (SET.autoContinueAfterCompaction === false) return;
  if (S.isStreaming || S.compacting) return;
  const now = Date.now();
  if (now - S.lastAutoContinueAt < 120000) return; // don't chain-continue forever
  S.lastAutoContinueAt = now;
  toast('Compaction done — continuing the task…', 'info');
  sendPrompt('Context was just compacted into a summary. Continue the current task from where it left off — use the compaction summary and the recent messages, and keep working until the task is complete.');
}

function renderQueue() {
  const bar = $('queue-bar');
  const items = [...S.queue.steering.map((m) => ({ kind: 'steering', m })), ...S.queue.followUp.map((m) => ({ kind: 'after turn', m }))];
  if (!items.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  bar.appendChild(el('span', null, 'queued '));
  for (const { kind, m } of items) {
    const text = (typeof m === 'string' ? m : JSON.stringify(m || '')).slice(0, 120);
    const chip = el('span', 'queue-chip', `${kind}: ${text}`);
    bar.appendChild(chip);
  }
}

/* ───────────────────────── composer / sending ───────────────────────── */

const input = $('input');

function autoSize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  syncComposerText();
  // The chat shrinks as the box grows; without this the transcript shifted up
  // and the last thing written (a compaction marker, a tool call) slid out of
  // view while typing.
  if (S.stickToBottom) pinSoon();
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

  // Prompts go to the agent's own session — never to the one being viewed.
  // (!bash above is session-independent and stays allowed.)
  if (S.viewSession && !text.startsWith('/')) {
    toast(S.isStreaming
      ? 'The agent is running in another session — click it in the list (green dot) to switch back before sending'
      : 'You are viewing another session — switch back before sending');
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
  const all = images || [];
  const imgs = all.filter((a) => a.type === 'image');
  const files = all.filter((a) => a.type === 'file');
  // Non-image attachments travel as path references in the prompt text so the
  // agent can open them with its tools (read, bash, etc.). Audio also carries
  // its transcript inline.
  let msg = text || '';
  if (files.length) {
    const refs = files.map((f) => {
      let line = `[Attached ${f.kind}: ${f.name} → ${f.path}]`;
      if (f.kind === 'audio' && f.transcript) line += `\nTranscript: ${f.transcript}`;
      else if (f.kind === 'audio') line += ' (no transcript available)';
      return line;
    }).join('\n');
    msg = (msg ? msg + '\n\n' : '') + refs;
  }
  const cmd = { type: 'prompt', message: msg };
  if (imgs.length) {
    cmd.images = imgs.map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType }));
  }
  if (S.isStreaming) cmd.streamingBehavior = behavior || 'steer';
  rpc(cmd).catch((e) => toast(e.message, 'error'));
  // Optimistic bubble; replaced by the authoritative history on the next agent_end.
  if (text || all.length) {
    const content = [];
    for (const a of imgs) content.push({ type: 'image', data: a.data, mimeType: a.mimeType });
    if (msg) content.push({ type: 'text', text: msg });
    renderUserMessage({ role: 'user', content: content.length ? content : msg, timestamp: Date.now(), __live: true });
    S.stickToBottom = true;
    scrollBottom(true);
  }
}

async function sendBash(command) {
  const { root, bubble } = makeMsgShell('system', `system · ${timeStr()}`);
  root.querySelector('.who').remove();
  const out = el('div', null, `$ ${command}\n`);
  bubble.appendChild(out);
  transcriptHost().appendChild(root);
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
  syncComposerText();
  input.focus();
}

/* The ring around the typed text stays visible whenever the composer has
 * content, not only while it is focused, so the box never looks empty. */
function syncComposerText() {
  const row = document.querySelector('.composer-row');
  if (!row) return;
  row.classList.toggle('has-text', !!input.value.trim() || S.attachments.length > 0);
}

$('btn-send').onclick = sendCurrent;
$('btn-stop').onclick = stopAgent;

async function stopAgent() {
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); S.speaking = false; return; }
  try {
    // pi's RPC has no clear_queue command — the pending queue is tracked
    // client-side via queue_update events, so restore it from there.
    const restored = [...S.queue.steering, ...S.queue.followUp]
      .map((m) => (typeof m === 'string' ? m : ''))
      .filter(Boolean);
    await rpc({ type: 'abort' });
    S.queue = { steering: [], followUp: [] };
    renderQueue();
    if (restored.length) {
      input.value = restored.join('\n---\n') + (input.value ? '\n' + input.value : '');
      autoSize();
    }
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
    type: 'image',
    data: dataUrl.split(',')[1],
    mimeType: file.type,
    name: file.name || 'pasted-image',
  });
  renderAttachments();
}

/* File kind for non-image attachments. */
function fileKind(f) {
  if (f.type.startsWith('audio/')) return 'audio';
  if (f.type.startsWith('video/')) return 'video';
  if (f.type === 'application/pdf') return 'pdf';
  return 'file';
}

/* Upload a file to the workspace (bridge saves it under uploads/) so the
 * agent can read it with its tools. Returns {path, size}. */
async function uploadFile(file) {
  const data = await readAsDataUrl(file);
  const d = await (await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, data: data.split(',')[1], mimeType: file.type }),
  })).json();
  if (!d.ok) throw new Error(d.error || 'upload failed');
  return d;
}

/* Transcribe an audio file. Tries the bridge's local whisper first, then the
 * user-configured STT endpoint. Audio is converted to 16 kHz mono WAV in the
 * browser first so mp3/m4a/ogg/webm all work. */
async function transcribeAudioFile(file) {
  let wavBlob = file;
  try { wavBlob = await blobToWav(file); } catch { /* not browser-decodable; send raw */ }
  const dataUrl = await readAsDataUrl(wavBlob);
  const b64 = dataUrl.split(',')[1];
  // Whisper backend: make sure the local server is actually up first (it is
  // downloaded on demand), so picking whisper in settings "just works".
  if (SET.sttBackend === 'whisper') await ensureWhisper(true);
  try {
    const d = await (await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: b64 }),
    })).json();
    if (d.ok && d.text) return d.text;
  } catch { /* no local STT server */ }
  if (SET.sttEndpoint) {
    const fd = new FormData();
    fd.append('file', wavBlob, wavBlob.name || 'speech.wav');
    if (/\/v1\/audio\/transcriptions\/?$/.test(SET.sttEndpoint)) {
      fd.append('model', 'whisper-1');
      fd.append('response_format', 'json');
    }
    const res = await fetch(SET.sttEndpoint, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`STT server ${res.status}`);
    const d = await res.json();
    return d.text || d.transcription || '';
  }
  throw new Error('no STT endpoint available');
}

/* Attach any file: images go to the model as vision input; everything else
 * (PDF / audio / video / other) is uploaded to the workspace and referenced
 * by path in the prompt. Audio is transcribed when STT is available. */
async function addFile(file) {
  if (file.type.startsWith('image/')) { await addImageFile(file); return; }
  if (file.size > 100 * 1024 * 1024) { toast(`File too large (max 100 MB): ${file.name}`, 'error'); return; }
  const att = { type: 'file', kind: fileKind(file), name: file.name || 'file', mimeType: file.type, size: file.size };
  try {
    att.path = (await uploadFile(file)).path;
  } catch (e) {
    toast(`Upload failed: ${e.message}`, 'error');
    return;
  }
  if (att.kind === 'audio') {
    att.transcribing = true;
    S.attachments.push(att);
    renderAttachments();
    try { att.transcript = await transcribeAudioFile(file); }
    catch (e) { att.transcriptError = e.message; }
    att.transcribing = false;
  }
  S.attachments.push(att);
  renderAttachments();
}

function renderAttachments() {
  const wrap = $('attachments');
  wrap.innerHTML = '';
  wrap.classList.toggle('hidden', !S.attachments.length);
  syncComposerText();
  S.attachments.forEach((a, i) => {
    const box = el('div', `attachment${a.type === 'file' ? ' file' : ''}`);
    if (a.type === 'image') {
      const img = el('img');
      img.src = `data:${a.mimeType};base64,${a.data}`;
      img.title = a.name;
      box.appendChild(img);
    } else {
      const icon = el('div', 'file-icon', a.kind === 'pdf' ? 'PDF' : a.kind === 'audio' ? '♪' : a.kind === 'video' ? '▶' : '·');
      const meta = el('div', 'file-meta');
      meta.appendChild(el('div', 'file-name', a.name));
      const status = a.transcribing
        ? 'transcribing…'
        : a.transcript
          ? `transcribed: ${a.transcript.slice(0, 80)}${a.transcript.length > 80 ? '…' : ''}`
          : a.transcriptError
            ? `transcript failed (${a.transcriptError})`
            : `${(a.size / 1024).toFixed(0)} KB`;
      meta.appendChild(el('div', 'file-status', status));
      box.append(icon, meta);
    }
    const rm = el('button', 'rm', '×');
    rm.onclick = () => { S.attachments.splice(i, 1); renderAttachments(); };
    box.appendChild(rm);
    wrap.appendChild(box);
  });
}

function clearAttachments() {
  S.attachments = [];
  renderAttachments();
  syncComposerText();
}

$('btn-attach').onclick = () => $('file-input').click();
$('file-input').onchange = async (e) => {
  for (const f of e.target.files) await addFile(f);
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
  for (const f of e.dataTransfer?.files || []) await addFile(f);
});

/* ───────────────────────── slash commands ───────────────────────── */

/* handled by the UI itself, never sent to the agent */
const LOCAL_COMMANDS = [
  { name: 'tts', description: 'Toggle text-to-speech for agent replies', source: 'local' },
  { name: 'autosend', description: 'Toggle auto-send after voice input', source: 'local' },
  { name: 'thinking', description: 'Toggle showing thinking blocks', source: 'local' },
];

/* pi's built-in slash commands are implemented by its TUI, not by RPC mode:
 * using them from here either did nothing or went to the model as a prompt. The
 * UI maps the useful ones (compact, name, clone, copy, session, model,
 * thinking) to their RPC equivalents itself, and the rest belong to a button
 * somewhere - so the menu only offers what actually runs. Typing a hidden one
 * still works when the UI implements it. */
const HIDDEN_BUILTINS = new Set([
  'settings', 'model', 'scoped-models', 'export', 'import', 'share', 'changelog',
  'hotkeys', 'fork', 'tree', 'trust', 'login', 'logout', 'new', 'resume',
  'reload', 'quit',
]);

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
    .filter((c) => !(c.source === 'builtin' && HIDDEN_BUILTINS.has(c.name.toLowerCase())))
    .filter((c) => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))
    .slice(0, 300);   // the list scrolls; it used to be cut off at 12, which hid every skill
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
  // Span the composer: from the "+" button to "send".
  const row = document.querySelector('.composer-row') || input;
  const r = row.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.width = r.width + 'px';
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
  // pi only writes the session file once something happens in it, so a brand
  // new session is missing from /api/sessions until the first message. Show the
  // one the agent is actually on, otherwise "new session" looks like it did
  // nothing until a reload.
  const cur = S.state.sessionFile;
  if (cur && !sessions.some((s) => s.path === cur || s.fileName === cur.split(/[\\/]/).pop())) {
    sessions = [{
      path: cur,
      fileName: cur.split(/[\\/]/).pop(),
      name: (S.state.sessionName || '').trim() || 'new session',
      mtime: Date.now(),
      size: 0,
      pending: true,
    }, ...sessions];
  }
  list.innerHTML = '';
  S.sessionsList = sessions;
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
  // Order the list so a session is followed by the forks it spawned, instead of
  // everything being sorted by time: a branch belongs under the session it came
  // from.
  const byPath = new Map(sessions.map((s) => [s.path, s]));
  const ordered = [];
  const placed = new Set();
  for (const s of sessions) {
    if (s.parent && byPath.has(s.parent)) continue;      // rendered with its parent
    if (placed.has(s.path)) continue;
    ordered.push(s);
    placed.add(s.path);
    const kids = sessions.filter((x) => x.parent === s.path).sort((a, b) => b.mtime - a.mtime);
    for (const k of kids) { ordered.push(k); placed.add(k.path); }
  }
  for (const s of sessions) if (!placed.has(s.path)) ordered.push(s);

  const shown = ordered.filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.fileName.toLowerCase().includes(filter));
  if (!shown.length) list.appendChild(el('div', 'session-item s-meta', 'No sessions found'));
  const collapsed = SET.forkCollapsed || {};
  const hiddenForks = new Set();
  for (const [parentPath, isCollapsed] of Object.entries(collapsed)) {
    if (!isCollapsed) continue;
    for (const x of sessions) if (x.parent === parentPath) hiddenForks.add(x.path);
  }
  for (const s of shown) {
    if (hiddenForks.has(s.path)) continue;
    const item = el('div', 'session-item');
    // A session that was forked off another one: thinner row, smaller grey text
    // and an arrow in front, so the branch structure is visible in the list.
    const parentName = s.parent ? (byPath.get(s.parent) || {}).name : null;
    if (s.parent) {
      item.classList.add('fork');
      item.title = parentName ? `branched from "${parentName}"` : `branched from ${s.parent}`;
    }
    const kids = sessions.filter((x) => x.parent === s.path);
    const isCurrent = current && (s.path === current || s.fileName === current.split(/[\\/]/).pop());
    const isViewed = S.viewSession
      ? (s.path === S.viewSession || s.fileName === S.viewSession.split(/[\\/]/).pop())
      : false;
    // The blue highlight follows what you are looking at; the green pulsing dot
    // marks the session still running in the background. Highlighting both made
    // it look like two sessions were selected at once.
    if (S.viewSession ? isViewed : isCurrent) item.classList.add('active');
    if (isCurrent && S.isStreaming) item.classList.add('live');
    const nameRow = el('div', 's-name');
    if (isCurrent && S.isStreaming) nameRow.appendChild(el('span', 'live-dot', ''));
    nameRow.appendChild(document.createTextNode(s.name));
    if (kids.length) {
      // A toggle, not a badge: the branches fold away under their parent.
      const isCollapsed = !!(SET.forkCollapsed || {})[s.path];
      const toggle = el('span', 'fork-toggle', `${isCollapsed ? '▸' : '▾'} ${kids.length}`);
      toggle.title = isCollapsed ? `show ${kids.length} branch${kids.length > 1 ? 'es' : ''}` : 'hide the branches';
      toggle.onclick = (e) => {
        e.stopPropagation();
        SET.forkCollapsed = { ...(SET.forkCollapsed || {}), [s.path]: !isCollapsed };
        saveSettings();
        refreshSessions();
      };
      nameRow.appendChild(toggle);
    }
    item.appendChild(nameRow);
    item.appendChild(el('div', 's-meta', `${new Date(s.mtime).toLocaleString()} · ${(s.size / 1024).toFixed(1)} KB`));
    item.onclick = () => switchToSession(s.path);
    item.oncontextmenu = (e) => { e.preventDefault(); openSessionMenu(s, item); };
    list.appendChild(item);
  }
}

$('session-filter').oninput = () => refreshSessions();
$('btn-refresh-sessions').onclick = () => refreshSessions();

async function switchToSession(sessionPath) {
  const agentSession = S.state.sessionFile;
  if (sessionPath === agentSession) {
    if (!S.viewSession) return; // already here
    // Coming back to the agent's own session: re-render it and re-attach the
    // live view (if the agent is still running).
    S.viewSession = null;
    await refreshMessages();
    updateViewBanner();
    return;
  }
  if (S.isStreaming) {
    // The agent is running in its own session. Keep it running in the
    // background: park the live DOM (deltas keep landing in it) and view the
    // target session read-only from its file. The green dot in the session
    // list shows which session is still running.
    if (S.live) {
      const frag = document.createDocumentFragment();
      frag.appendChild(S.live.root); // detaches it from the visible chat
      S.liveDetached = { path: agentSession, frag };
    }
    S.viewSession = sessionPath;
    await renderSessionFromDisk(sessionPath);
    updateViewBanner();
    return;
  }
  // Agent is idle: move it to the selected session so input works there.
  try {
    await rpc({ type: 'switch_session', sessionPath });
    S.state.sessionFile = sessionPath;
    S.viewSession = null;
    $('session-name').value = '';
    await initSession(false);
    toast('Session switched');
  } catch (e) {
    // pi refuses to switch to a session whose recorded working directory is
    // gone (usually because the project folder was renamed). Offer to put the
    // folder back so the session can be opened again, instead of dead-ending on
    // a raw error.
    const missing = /working directory does not exist:\s*(.+?)\s*$/im.exec(e.message || '');
    if (missing && missing[1]) {
      const dir = missing[1].trim();
      const ok = confirm(
        `This session was recorded in\n\n${dir}\n\n` +
        'and that folder does not exist any more - it was renamed or moved.\n\n' +
        'Create the folder again so the session can be opened?');
      if (!ok) {
        toast('Session not opened - its recorded folder is missing', 'warning');
        return;
      }
      try {
        const r = await fetch('/api/ensure-dir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'could not create it');
        await rpc({ type: 'switch_session', sessionPath });
        S.state.sessionFile = sessionPath;
        S.viewSession = null;
        $('session-name').value = '';
        await initSession(false);
        toast('Session opened - its old folder was recreated');
      } catch (e2) {
        toast(`Still could not open it: ${e2.message}`, 'error');
      }
      return;
    }
    toast(`Switch failed: ${e.message}`, 'error');
  }
}

// Read-only render of another session's transcript straight from its file.
async function renderSessionFromDisk(sessionPath) {
  try {
    const d = await fetchSession(sessionPath);
    const msgs = d.messages;
    const distFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
    chat.innerHTML = '';
    transcriptTarget = chat;
    for (const m of msgs) {
      if (m.role === 'user') renderUserMessage(m);
      else if (m.role === 'assistant') renderAssistantMessage(m);
      else if (m.role === 'toolResult') renderToolResult(m);
      else if (m.role === 'bashExecution') renderBashExecution(m);
      else if (m.role === 'compactionSummary') renderCompactionSummary(m);
    }
    transcriptTarget = null;
    // Put the file's compaction markers back where they happened.
    if (d.compactions.length) {
      const plain = [...chat.querySelectorAll('.msg:not(.compaction)')];
      for (const k of d.compactions) {
        let target = null;
        for (const n of plain) {
          const ts = Number(n.dataset.ts);
          if (k.at && ts && ts <= k.at) target = n;
        }
        const node = buildCompactionSummary(k, { live: true, count: d.compactions.length });
        if (target) target.after(node);
        else if (plain.length) plain[0].before(node);
        else chat.appendChild(node);
      }
    }
    if (S.stickToBottom) scrollBottom(true);
    else chat.scrollTop = chat.scrollHeight - chat.clientHeight - distFromBottom;
  } catch (e) {
    toast(`Could not load session: ${e.message}`, 'error');
  }
}

$('btn-new-session').onclick = async () => {
  try {
    await rpc({ type: 'new_session' });
    await initSession(false);
    // The file for a fresh session does not exist yet, so the list has nothing
    // to show. Re-check shortly (and after the first message lands) as well.
    refreshSessions().catch(() => {});
    setTimeout(() => refreshSessions().catch(() => {}), 700);
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
  // llama.cpp entries use "provider||modelId" because the provider id itself
  // contains colons (llama-server=http://host:8080).
  let provider, modelId;
  const sep = e.target.value.indexOf('||');
  if (sep >= 0) {
    provider = e.target.value.slice(0, sep);
    modelId = e.target.value.slice(sep + 2);
  } else {
    [provider, ...rest] = e.target.value.split(':');
    modelId = rest.join(':');
  }
  const isLlama = provider.startsWith('llama-server=');
  // If pi has not registered this llama provider yet (its configured URL is
  // dead), point pi at the live server, restart the agent, then retry.
  if (isLlama && !S.models.some((m) => m.provider === provider)) {
    const live = llamaLiveServers.find((s) => s.providerId === provider);
    if (live && confirm(`pi has not registered the llama.cpp server at ${live.url} yet.\n\nPoint pi at it and restart the agent? (updates llamaServerUrl in your pi config)`)) {
      S.pendingModel = { provider, modelId };
      fixLlamaConfig(live.url);
    }
    return;
  }
  try {
    await rpc({ type: 'set_model', provider, modelId });
    await rpc({ type: 'get_state' }).then(applyState);
    toast(isLlama ? 'Model switched — loading into llama.cpp…' : 'Model switched');
  } catch (err) {
    toast(err.message + (isLlama
      ? ' — pi does not know this model yet. If the llama.cpp banner is showing, use "Point pi here & reload", or type /models in the chat'
      : ''), 'error');
  }
};

$('thinking-select').onchange = async (e) => {
  const wanted = e.target.value;
  try {
    const d = await rpc({ type: 'set_thinking_level', level: wanted });
    // The button is the only part of this control you can actually see (the
    // select is hidden), and it was refreshed by the full state sync alone - so
    // a new level showed up on the next page load and not before.
    if (d && d.thinkingLevel) syncSelect($('thinking-select'), d.thinkingLevel);
    updateThinkingBtn();
    toast(`Thinking level: ${$('thinking-select').value}`);
  } catch (err) {
    toast(err.message, 'error');
    // Put the old value back: the select had already been moved by the menu.
    rpc({ type: 'get_state' }).then(applyState).catch(() => {});
  }
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
  $('set-font').value = SET.fontFamily || '';
  $('set-show-thinking').checked = SET.showThinking !== false;
  $('set-expand-thinking').checked = !!SET.autoExpandThinking;
  $('set-expand-tools').checked = !!SET.autoExpandTools;
  $('set-stt-endpoint').value = SET.sttEndpoint || '';
  syncVoiceSettingsUi();
  $('set-tts-backend').value = SET.ttsBackend || 'browser';
  $('set-tts-endpoint').value = SET.ttsEndpoint || '';
  $('set-tts-model').value = SET.ttsModel || '';
  $('set-tts-voice-name').value = SET.ttsVoiceName || '';
  $('set-accent').value = SET.themeAccent || '#5b9dff';
  $('set-bg-url').value = SET.themeBg && !SET.themeBg.startsWith('data:') && !SET.themeBg.startsWith('/api/bg-file') ? SET.themeBg : '';
  $('set-tts-rate').value = SET.ttsRate;
  $('set-tts-rate-val').textContent = Number(SET.ttsRate).toFixed(2);
  // System font list for the searchable font picker (loaded async).
  loadSystemFonts();
  $('set-font-size').value = Number(SET.chatFontSize) || 14;
  $('set-font-size-val').textContent = `${Number(SET.chatFontSize) || 14}px`;
  $('set-chat-opacity').value = SET.chatOpacity == null ? 100 : Number(SET.chatOpacity);
  $('set-chat-opacity-val').textContent = `${SET.chatOpacity == null ? 100 : Number(SET.chatOpacity)}%`;
  const tOut = $('set-text-outline');
  if (tOut) tOut.checked = SET.textOutline !== false;
  const tCol = $('set-outline-color');
  if (tCol) tCol.value = SET.textOutlineColor || '#000000';
  const avSize = $('set-avatar-size');
  if (avSize) {
    avSize.value = String(Number(SET.avatarSize) || 34);
    $('set-avatar-size-val').textContent = `${Number(SET.avatarSize) || 34}px`;
  }
  const ta = $('set-type-anywhere');
  if (ta) ta.checked = SET.typeAnywhere === true;
  $('set-shorts-provider').value = SHORTS_FEEDS[SET.shortsProvider] ? SET.shortsProvider : 'none';
  $('set-shorts-auto').checked = SET.shortsAutoOpen === true;
  const legacyMode = { split: 'panel', popup: 'window' }[SET.shortsMode] || SET.shortsMode;
  $('set-shorts-mode').value = (legacyMode === 'tab' || legacyMode === 'window') ? legacyMode : 'panel';
  $('set-auto-continue').checked = SET.autoContinueAfterCompaction !== false;
  populateTtsVoiceSelect();
  loadPiProviders();
  loadAuthProviders();
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
  e.target.value = '';
  if (!f) return;
  const isVideo = f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(f.name);
  const isImage = f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name);
  if (!isVideo && !isImage) { toast('Pick an image, GIF or video file', 'warning'); return; }
  toast(isVideo ? 'Uploading profile video…' : 'Uploading profile image…');
  try {
    // Uploaded like the background rather than inlined: a GIF or a short video
    // as a data URL would blow the localStorage quota.
    const up = await uploadFile(f);
    SET.avatar = `/api/bg-file?name=${encodeURIComponent(up.path.split(/[\\/]/).pop())}`;
    SET.avatarCrop = null;
    saveSettings();
    toast('Profile image updated — adjust the framing if needed');
    openCropper('avatar');
  } catch (err) {
    if (isImage && f.size < 1.5 * 1024 * 1024) {
      try {
        SET.avatar = await readAsDataUrl(f);
        SET.avatarCrop = null;
        saveSettings();
        toast('Profile image set for this session (bridge not reachable to store it)');
        return;
      } catch { /* fall through */ }
    }
    toast(`Upload failed: ${err.message}`, 'error');
  }
};
$('btn-avatar-crop').onclick = () => openCropper('avatar');
$('btn-avatar-clear').onclick = () => {
  SET.avatar = null;
  SET.avatarCrop = null;
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
wireVoiceSettings();
$('set-show-thinking').onchange = (e) => {
  SET.showThinking = e.target.checked;
  saveSettings();
};
$('set-show-tools').onchange = (e) => {
  SET.showToolCalls = e.target.checked;
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
  e.target.value = '';
  if (!f) return;
  // Anything the user picks is uploaded to the bridge and referenced by URL —
  // a multi-MB GIF/video as a data URL would overflow localStorage.
  const isVideo = f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(f.name);
  const isImage = f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name);
  if (!isVideo && !isImage) { toast('Pick an image, GIF or video file', 'warning'); return; }
  toast(isVideo ? 'Uploading background video…' : 'Uploading background…');
  try {
    const up = await uploadFile(f);
    SET.themeBg = `/api/bg-file?name=${encodeURIComponent(up.path.split(/[\\/]/).pop())}`;
    SET.bgCrop = null;
    saveSettings();
    toast(isVideo ? 'Video background set' : 'Background set');
    openCropper('bg');
  } catch (err) {
    // offline bridge: fall back to inlining small images so it still works
    if (isImage && f.size < 1.5 * 1024 * 1024) {
      try {
        SET.themeBg = await readAsDataUrl(f);
        saveSettings();
        toast('Background set for this session (bridge not reachable to store it)');
        return;
      } catch { /* fall through */ }
    }
    toast(`Upload failed: ${err.message}`, 'error');
  }
};
$('btn-bg-clear').onclick = () => { SET.themeBg = null; SET.bgCrop = null; saveSettings(); };
$('btn-bg-crop').onclick = () => openCropper('bg');

/* Apply SET.themeBg to the page. Images, GIFs and videos all render as a real
 * element behind the app, so one code path (and one crop) covers all three -
 * a body background-image could not be zoomed or panned by hand. */
function applyBackgroundMedia() {
  const host = $('bg-media');
  const src = SET.themeBg || '';
  if (!host) return;
  host.innerHTML = '';
  if (!src) { host.classList.add('hidden'); return; }
  const frame = window.innerWidth / Math.max(1, window.innerHeight);
  const node = attachCrop(mediaNode(src, 'bg-node'), SET.bgCrop, frame);
  node.onerror = () => toast(isVideoSrc(src) ? 'Background video failed to load' : 'Background image failed to load', 'error');
  host.appendChild(node);
  host.classList.remove('hidden');
}

/* The frame aspect is the window's, so a resize changes how much of a cropped
 * background fits. Re-apply instead of rebuilding - rebuilding would restart a
 * background video. */
window.addEventListener('resize', () => {
  const n = document.querySelector('#bg-media img, #bg-media video');
  if (n) applyCrop(n, SET.bgCrop, window.innerWidth / Math.max(1, window.innerHeight));
});

/* ── manual crop ──────────────────────────────────────────────────────────
 * Drag to move, scroll (or use the slider) to zoom. The crop is stored as an
 * object-position percentage plus a zoom factor, so it survives reloads and
 * applies at every size the media is shown at. */
/* ── manual crop ──────────────────────────────────────────────────────────
 * The stage shows the WHOLE picture (object-fit: contain) with the crop area
 * drawn on top as a frame, so you can see what you are cutting off. It used to
 * show the image already cover-cropped to the frame, which made every crop
 * guesswork. The frame is fixed in place and the picture moves under it.
 *
 * Stored crop: { v:2, fx, fy, z } - fx/fy are -1..1 across the available pan
 * range (0 = centred), z is the zoom relative to the cover fit. Rendering uses
 * the same maths as before (translate + scale over a centred cover layout). */
let cropState = null;

/* Older crops stored object-position percentages; convert them on the way in. */
function normalizeCrop(crop) {
  if (!crop) return null;
  if (crop.v === 2) return crop;
  const f = (p) => Math.max(-1, Math.min(1, ((p == null ? 50 : Number(p)) - 50) / 50));
  return { v: 2, fx: f(crop.x), fy: f(crop.y), z: Math.max(1, Number(crop.z) || 1) };
}

function cropRatios(node, frameAspect) {
  const nw = node.naturalWidth || node.videoWidth || 0;
  const nh = node.naturalHeight || node.videoHeight || 0;
  const a = frameAspect || 1;
  if (!nw || !nh) return { cw: 1, ch: 1, ready: false };
  const b = nw / nh;
  return { cw: Math.max(1, b / a), ch: Math.max(1, a / b), ready: true };
}

function applyCrop(node, crop, frameAspect) {
  if (!node) return;
  const c = normalizeCrop(crop);
  const nw = node.naturalWidth || node.videoWidth || 0;
  const nh = node.naturalHeight || node.videoHeight || 0;
  if (!c || !nw || !nh) {
    node.style.width = '';
    node.style.height = '';
    node.style.objectPosition = '';
    node.style.transform = '';
    return;
  }
  const { cw, ch } = cropRatios(node, frameAspect);
  const z = Math.max(1, Number(c.z) || 1);
  // The element is sized to the cover rect of its frame (E = cw·B) and the frame
  // wrapper clips it. object-fit content is clipped to the element box, so
  // translating a box the same size as the frame dragged it away from under its
  // own picture and left black gaps - the picture has to be bigger than the
  // frame and move inside it.
  node.style.width = `${cw * 100}%`;
  node.style.height = `${ch * 100}%`;
  node.style.objectPosition = '50% 50%';
  // Pan range at zoom z is (z·E − B)/2, which as a share of the element is
  // 50·(z − B/E) = 50·(z − 1/cw). Negative because moving the visible window to
  // the right means moving the picture to the left.
  const tx = -(Number(c.fx) || 0) * 50 * (z - 1 / cw);
  const ty = -(Number(c.fy) || 0) * 50 * (z - 1 / ch);
  node.style.transform = `translate(${tx}%, ${ty}%) scale(${z})`;
}

/* The natural size - and with it the pan ranges - only exists after load. */
function attachCrop(node, crop, frameAspect) {
  applyCrop(node, crop, frameAspect);
  const again = () => applyCrop(node, crop, frameAspect);
  node.addEventListener('load', again);
  node.addEventListener('loadedmetadata', again);
  return node;
}

/* Where the crop frame sits on the stage, and how much the picture can move.
 * Everything is in stage pixels; the frame stays put and the picture moves. */
function cropGeometry() {
  if (!cropState) return null;
  const { node, frame, fx, fy, z } = cropState;
  const stage = $('crop-stage');
  const nw = node.naturalWidth || node.videoWidth || 0;
  const nh = node.naturalHeight || node.videoHeight || 0;
  if (!stage || !nw || !nh) return null;
  const sr = stage.getBoundingClientRect();
  const s = Math.min(sr.width / nw, sr.height / nh);      // contain fit: whole picture visible
  const b = nw / nh;
  const baseW = b >= frame ? nh * frame : nw;             // biggest frame-shaped rect in the image
  const baseH = b >= frame ? nh : nw / frame;
  const cropW = baseW / z;
  const cropH = baseH / z;
  // How far the crop rect can travel inside the *picture* - using the base rect
  // here instead would leave nothing to pan at zoom 1 and only a fraction of
  // the picture to choose from further in.
  const rangeX = (nw - cropW) / 2;
  const rangeY = (nh - cropH) / 2;
  const cx = nw / 2 + (Number(fx) || 0) * rangeX;
  const cy = nh / 2 + (Number(fy) || 0) * rangeY;
  const left = (sr.width - nw * s) / 2 + (cx - cropW / 2) * s;
  const top = (sr.height - nh * s) / 2 + (cy - cropH / 2) * s;
  return { s, rangeX, rangeY, left, top, w: cropW * s, h: cropH * s };
}

function paintCrop() {
  if (!cropState) return;
  const g = cropGeometry();
  const overlay = $('crop-frame');
  if (g && overlay) {
    overlay.classList.remove('hidden');
    overlay.style.left = `${g.left}px`;
    overlay.style.top = `${g.top}px`;
    overlay.style.width = `${g.w}px`;
    overlay.style.height = `${g.h}px`;
  }
  const { fx, fy, z } = cropState;
  const zoom = $('crop-zoom');
  if (zoom) { zoom.value = String(z); $('crop-zoom-val').textContent = `${z.toFixed(2)}×`; }
  const cx = $('crop-x'); if (cx) cx.value = String(fx);
  const cy = $('crop-y'); if (cy) cy.value = String(fy);
}

/* Move the crop frame by a drag, in pixels, on the (possibly zoomed) stage.
 * The frame follows the pointer - dragging up moves it up. It used to go the
 * other way, and since the picture itself stays put, that read as the picture
 * sliding backwards. */
function cropDrag(dx, dy) {
  if (!cropState) return;
  const g = cropGeometry();
  if (!g) return;   // not loaded yet
  const halfX = g.rangeX * g.s;
  const halfY = g.rangeY * g.s;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  if (halfX > 0.5) cropState.fx = clamp(cropState.fx + dx / halfX);
  if (halfY > 0.5) cropState.fy = clamp(cropState.fy + dy / halfY);
  paintCrop();
}

/* The dialog is not laid out the moment it opens, and inside an embedded webview
 * window.innerHeight can still read 0 - paintCrop then measured a zero-sized
 * stage and drew its mask over the whole thing, so on some machines the picture
 * was invisible. Retry across a few frames until the stage has a real size. */
function schedulePaint(frames) {
  const stage = $('crop-stage');
  if (!stage) return;
  const n = frames || 0;
  const tiny = stage.clientWidth < 24 || stage.clientHeight < 24;
  if (tiny && n < 20) { requestAnimationFrame(() => schedulePaint(n + 1)); return; }
  // Normally the stylesheet sizes the stage. Only if it really has no size -
  // an embedded webview reporting a 0x0 window before layout - put pixels in.
  if (tiny) {
    const size = Math.max(150, Math.round(Math.min(320, (window.innerHeight || 600) * 0.4)));
    stage.style.width = `${size}px`;
    stage.style.height = `${size}px`;
  }
  paintCrop();
}

function openCropper(kind) {
  const isAvatar = kind === 'avatar';
  const src = isAvatar ? SET.avatar : SET.themeBg;
  if (!src) {
    toast(isAvatar ? 'Upload a profile image first' : 'Upload a background first', 'warning');
    return;
  }
  const saved = normalizeCrop(isAvatar ? SET.avatarCrop : SET.bgCrop) || {};
  const stage = $('crop-stage');
  const media = $('crop-media');
  const node = mediaNode(src, 'crop-node');
  media.replaceChildren(node);
  // If the picture cannot be decoded here, say so rather than showing an empty
  // frame - a cropper that looks "invisible" usually means this.
  setTimeout(() => {
    const hint = $('crop-hint');
    if (node.naturalWidth || node.videoWidth) return;
    if (hint && !/did not load/.test(hint.textContent)) hint.textContent += '  (the picture did not load on this device)';
  }, 1800);
  $('crop-title').textContent = isAvatar ? 'Crop profile image' : 'Crop background';
  $('crop-hint').textContent = isAvatar
    ? 'The circle is what the chat will show. Drag the picture to move it, scroll or use the slider to zoom - zooming in lets you slide it further.'
    : 'The frame is what you will see on screen. Drag the picture to move it, scroll or use the slider to zoom - zooming in lets you slide it further.';
  stage.classList.toggle('circle', isAvatar);
  const frame = isAvatar ? 1 : window.innerWidth / Math.max(1, window.innerHeight);
  cropState = {
    kind,
    node,
    frame,
    fx: saved.fx == null ? 0 : Number(saved.fx),
    fy: saved.fy == null ? 0 : Number(saved.fy),
    z: saved.z == null ? 1 : Math.max(1, Number(saved.z)),
  };
  // Show the picture at its own shape, so nothing is hidden from the start.
  const setStage = () => {
    const nw = node.naturalWidth || node.videoWidth || 0;
    const nh = node.naturalHeight || node.videoHeight || 0;
    // Sized inline, in pixels: the avatar stage is a square that always fits the
    // window, so the round crop window is a circle and the save/cancel buttons
    // can never end up below the screen. A wide picture keeps its own shape on
    // the background cropper only.
    if (isAvatar) {
      stage.style.aspectRatio = '1 / 1';
    } else if (nw && nh) {
      stage.style.aspectRatio = `${nw} / ${nh}`;
    }
    schedulePaint();
  };
  setStage();
  node.addEventListener('load', setStage);
  node.addEventListener('loadedmetadata', setStage);
  const dlg = $('crop-dialog');
  // Always leave a way out: the dialog scrolls, Escape closes it, and closing it
  // for any reason (not just the buttons) drops the crop state.
  dlg.style.maxHeight = '92vh';
  dlg.style.overflow = 'auto';
  if (!dlg.__wired) {
    dlg.__wired = true;
    dlg.addEventListener('close', () => { cropState = null; });
    // Escape has to work on the fallback overlay too, where there is no native
    // dialog behaviour to close it.
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && $('crop-dialog') && $('crop-dialog').classList.contains('cropper-open')) {
        ev.preventDefault();
        closeCropper();
      }
    });
  }
  if (!dlg.open && !dlg.classList.contains('cropper-open')) showCropDialog(dlg);
}

/* <dialog> + showModal is patchy on older mobile browsers and embedded
 * webviews. Where it does not work the crop dialog simply never appeared - the
 * click looked like it did nothing. Fall back to a plain fixed overlay, and
 * verify afterwards that the dialog is really on screen. */
function showCropDialog(dlg) {
  let modal = false;
  try {
    if (typeof dlg.showModal === 'function') { dlg.showModal(); modal = dlg.open === true; }
  } catch { modal = false; }
  dlg.classList.add('cropper-open');
  document.body.classList.add('modal-open');
  if (!modal) {
    dlg.setAttribute('open', '');
    dlg.classList.add('cropper-forced');
    return;
  }
  // Supported, but check it landed somewhere visible: if not, force the overlay.
  requestAnimationFrame(() => {
    const r = dlg.getBoundingClientRect();
    const h = window.innerHeight || 0;
    if (!r.width || !r.height || r.bottom < 8 || (h && r.top > h)) dlg.classList.add('cropper-forced');
  });
}

function closeCropper() {
  cropState = null;
  const dlg = $('crop-dialog');
  if (dlg && dlg.open) dlg.close();
  if (dlg) {
    dlg.classList.remove('cropper-open', 'cropper-forced');
    dlg.removeAttribute('open');
  }
  // A leftover Escape-opened state used to leave the dialog modal-blocking the
  // page with nothing clickable behind it.
  document.body.classList.remove('modal-open');
}

function saveCrop() {
  if (!cropState) return closeCropper();
  const crop = {
    v: 2,
    fx: Math.round(cropState.fx * 100) / 100,
    fy: Math.round(cropState.fy * 100) / 100,
    z: Math.round(cropState.z * 100) / 100,
  };
  if (cropState.kind === 'avatar') SET.avatarCrop = crop; else SET.bgCrop = crop;
  closeCropper();
  saveSettings();   // applySettings re-renders the background and every avatar
  toast('Crop saved');
}

(function wireCropper() {
  const stage = $('crop-stage');
  if (!stage) return;
  let dragging = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!cropState) return;
    dragging = { x: e.clientX, y: e.clientY };
    stage.classList.add('dragging');
    try { stage.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging || !cropState) return;
    cropDrag(e.clientX - dragging.x, e.clientY - dragging.y);
    dragging = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => { dragging = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (e) => {
    if (!cropState) return;
    e.preventDefault();
    const z = cropState.z * (e.deltaY > 0 ? 0.92 : 1.08);
    cropState.z = Math.max(1, Math.min(6, z));
    paintCrop();
  }, { passive: false });
  $('crop-zoom').oninput = (e) => { if (cropState) { cropState.z = Number(e.target.value) || 1; paintCrop(); } };
  $('crop-x').oninput = (e) => { if (cropState) { cropState.fx = Number(e.target.value); paintCrop(); } };
  $('crop-y').oninput = (e) => { if (cropState) { cropState.fy = Number(e.target.value); paintCrop(); } };
  $('crop-reset').onclick = () => {
    if (!cropState) return;
    cropState.fx = 0; cropState.fy = 0; cropState.z = 1;
    paintCrop();
  };
  $('crop-cancel').onclick = closeCropper;
  $('crop-save').onclick = saveCrop;
  // A close event is queued, not immediate, so one from an earlier close can
  // land after the dialog was reopened - only clear the state when the dialog
  // is really shut, or the fresh cropper would go dead.
  $('crop-dialog').addEventListener('close', () => {
    if (!$('crop-dialog').open) cropState = null;
  });
})();

/* appearance: font + text size */
/* Searchable system-font picker: enumerate installed fonts via the bridge
 * (Windows font registry) and offer them in a datalist under the font input.
 * Preset names (System/Monospace/Serif/Rounded) stay available too. */
let systemFontsLoaded = false;
async function loadSystemFonts() {
  const list = $('font-list');
  if (!list) return;
  if (systemFontsLoaded) return;
  try {
    const d = await (await fetch('/api/system-fonts')).json();
    const fonts = d.fonts || [];
    list.innerHTML = '';
    for (const f of fonts) list.appendChild(el('option', null, f));
    systemFontsLoaded = true;
  } catch { /* bridge may be old — picker still works with presets */ }
}

function applyFontChoice(value) {
  const v = (value || '').trim();
  const preset = {
    '': '', 'system (segoe ui)': '', 'monospace': 'mono', 'serif': 'serif', 'rounded': 'rounded',
  };
  if (v.toLowerCase() in preset) SET.fontFamily = preset[v.toLowerCase()];
  else SET.fontFamily = v; // raw system font family name
  saveSettings();
}

$('set-font').oninput = (e) => { applyFontChoice(e.target.value); };
$('set-font').onchange = (e) => { applyFontChoice(e.target.value); };
if ($('btn-font-reset')) $('btn-font-reset').onclick = () => {
  $('set-font').value = '';
  applyFontChoice('');
  toast('Font reset to system default');
};
$('set-font-size').oninput = (e) => {
  SET.chatFontSize = parseInt(e.target.value, 10) || 14;
  $('set-font-size-val').textContent = `${SET.chatFontSize}px`;
  applySettings();
};
$('set-font-size').onchange = () => saveSettings();

/* chatbox transparency: applies live while dragging, persists on release */
$('set-chat-opacity').value = SET.chatOpacity == null ? 100 : Number(SET.chatOpacity);
$('set-chat-opacity-val').textContent = `${SET.chatOpacity == null ? 100 : Number(SET.chatOpacity)}%`;
$('set-chat-opacity').oninput = (e) => {
  SET.chatOpacity = parseInt(e.target.value, 10);
  $('set-chat-opacity-val').textContent = `${SET.chatOpacity}%`;
  applySettings();
};
$('set-chat-opacity').onchange = () => saveSettings();

/* text outline + avatar size + typing */
$('set-text-outline').onchange = (e) => { SET.textOutline = e.target.checked; saveSettings(); };
$('set-outline-color').oninput = (e) => { SET.textOutlineColor = e.target.value; applySettings(); };
$('set-outline-color').onchange = () => saveSettings();
$('set-avatar-size').oninput = (e) => {
  SET.avatarSize = parseInt(e.target.value, 10);
  $('set-avatar-size-val').textContent = `${SET.avatarSize}px`;
  applySettings();
};
$('set-avatar-size').onchange = () => saveSettings();
$('set-type-anywhere').onchange = (e) => { SET.typeAnywhere = e.target.checked; saveSettings(); };

/* shorts feed */
$('set-shorts-provider').onchange = (e) => { SET.shortsProvider = e.target.value; saveSettings(); };
$('set-shorts-auto').onchange = (e) => { SET.shortsAutoOpen = e.target.checked; saveSettings(); };
$('set-shorts-mode').onchange = (e) => { SET.shortsMode = e.target.value; saveSettings(); };
$('set-auto-continue').onchange = (e) => { SET.autoContinueAfterCompaction = e.target.checked; saveSettings(); };

/* settings tabs */
document.querySelectorAll('#settings-tabs .tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('#settings-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('#settings-dialog .tab-panel').forEach((p) => {
      p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`);
    });
  };
});

/* first-launch setup */
function maybeShowSetup() {
  if (SET.onboarded) return;
  $('setup-agent-name').value = SET.agentName === 'pi' ? '' : SET.agentName;
  $('setup-shorts-provider').value = SHORTS_FEEDS[SET.shortsProvider] ? SET.shortsProvider : 'instagram';
  $('setup-accent').value = SET.themeAccent || '#5b9dff';
  $('setup-dialog').showModal();
}
$('setup-skip').onclick = () => {
  SET.onboarded = true;
  saveSettings();
  $('setup-dialog').close();
};
$('setup-accent-reset').onclick = () => { $('setup-accent').value = '#5b9dff'; };
$('setup-done').onclick = () => {
  const name = $('setup-agent-name').value.trim();
  if (name) SET.agentName = name;
  const prov = $('setup-shorts-provider').value;
  if (SHORTS_FEEDS[prov] || prov === 'none') SET.shortsProvider = prov;
  const acc = $('setup-accent').value;
  SET.themeAccent = acc && acc !== '#5b9dff' ? acc : null;
  SET.onboarded = true;
  saveSettings();
  $('setup-dialog').close();
  toast(`Welcome, ${SET.agentName || 'pi'}!`);
};

/* ───────────────────────── pi providers (models.json) ───────────────────────── */

async function loadPiProviders() {
  const list = $('pi-providers-list');
  list.innerHTML = '';
  list.appendChild(el('div', 'prov-empty', 'loading…'));
  try {
    const d = await fetch('/api/pi-providers').then((r) => r.json());
    list.innerHTML = '';
    const provs = Object.entries(d.providers || {});
    if (!provs.length) {
      list.appendChild(el('div', 'prov-empty', 'no custom providers yet'));
      return;
    }
    for (const [id, p] of provs) {
      const row = el('div', 'prov-row');
      const info = el('div', 'prov-info');
      info.appendChild(el('div', 'prov-id', id));
      info.appendChild(el('div', 'prov-meta',
        `${p.baseUrl || '—'} · ${p.models?.length || 0} models · key ${p.hasApiKey ? '✓' : '—'}`));
      const btn = el('button', 'btn small', 'remove');
      btn.title = `Remove provider "${id}" from pi's models.json`;
      btn.onclick = async () => {
        if (!confirm(`Remove provider "${id}" from pi's models.json?`)) return;
        try {
          const r = await fetch(`/api/pi-providers?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
          const out = await r.json();
          if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
          toast(`Provider "${id}" removed`);
          loadPiProviders();
          refreshModels();
        } catch (e) { toast(e.message, 'error'); }
      };
      row.append(info, btn);
      list.appendChild(row);
    }
  } catch {
    list.innerHTML = '';
    list.appendChild(el('div', 'prov-empty', 'bridge offline'));
  }
}

$('btn-prov-discover').onclick = async () => {
  const url = $('prov-base-url').value.trim().replace(/\/+$/, '');
  if (!url) { toast('Enter the base URL first', 'warning'); return; }
  const btn = $('btn-prov-discover');
  btn.disabled = true;
  try {
    const r = await fetch('/api/probe-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `probe failed (${r.status})`);
    if (!d.models.length) { toast('No models found at that URL', 'warning'); return; }
    $('prov-models').value = d.models.map((m) => m.id).join('\n');
    toast(`Found ${d.models.length} models`);
  } catch (e) {
    toast(`Discover failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
};

$('btn-prov-test').onclick = async () => {
  const baseUrl = $('prov-base-url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) { toast('Enter a valid base URL first', 'warning'); return; }
  const btn = $('btn-prov-test');
  btn.disabled = true;
  btn.textContent = 'testing…';
  try {
    const r = await fetch('/api/probe-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        api: $('prov-api').value,
        apiKey: $('prov-api-key').value.trim(),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `probe failed (${r.status})`);
    if (d.ok) {
      toast(`✓ Connection works — model "${d.model}" replied: ${d.sample || '(empty)'}`);
      if (d.models.length && !$('prov-models').value.trim()) {
        $('prov-models').value = d.models.join('\n');
        toast(`Filled ${d.models.length} discovered models`);
      }
    } else if (d.empty) {
      toast(`✗ Endpoint answered HTTP ${d.status} but with an EMPTY reply — check the URL path (e.g. OpenAI-style needs /v1, not /anthropic)`, 'error');
    } else {
      toast(`✗ ${d.error || `HTTP ${d.status}`}`, 'error');
    }
  } catch (e) {
    toast(`Test failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'test connection';
  }
};

$('btn-prov-add').onclick = async () => {
  const id = $('prov-id').value.trim();
  const baseUrl = $('prov-base-url').value.trim();
  const api = $('prov-api').value;
  const apiKey = $('prov-api-key').value.trim();
  const models = $('prov-models').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!id) { toast('Provider id is required', 'warning'); return; }
  if (!/^https?:\/\//i.test(baseUrl)) { toast('Base URL must start with http:// or https://', 'warning'); return; }
  const btn = $('btn-prov-add');
  btn.disabled = true;
  try {
    const r = await fetch('/api/pi-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, baseUrl, api, apiKey: apiKey || undefined, models }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `failed (${r.status})`);
    toast(`Provider "${id}" saved to pi — new models appear in the model list`);
    $('prov-api-key').value = '';
    $('prov-models').value = '';
    loadPiProviders();
    refreshModels(); // pi re-reads models.json when the model list is opened
  } catch (e) {
    toast(`Save failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
};

/* ───────────────────────── pi /login (auth.json) ───────────────────────── */

// Credentials pi's /login saves: ~/.pi/agent/auth.json, keyed by provider id.
// "login" = store an API key, "logout" = remove it. The agent restarts after
// either, because it reads auth.json at startup.
//
// The old UI listed all ~33 known providers at once, which buried the two or
// three that actually matter. Now it is a searchable picker: type (or pick from
// the suggestions) and the state of that one provider is shown below.
let authProviders = {};

async function loadAuthProviders() {
  const dl = $('auth-provider-ids');
  const status = $('auth-status');
  const list = $('auth-logged-in');
  if (!dl || !status || !list) return;
  try {
    const d = await fetch('/api/auth-providers').then((r) => r.json());
    authProviders = d.providers || {};
    dl.innerHTML = '';
    for (const id of Object.keys(authProviders)) dl.appendChild(el('option', null, id));
    renderAuthStatus();
    renderAuthLoggedIn();
  } catch {
    authProviders = {};
    status.className = 'auth-status';
    status.textContent = 'bridge offline';
    list.innerHTML = '';
  }
}

// State of the provider currently in the input (if any).
function renderAuthStatus() {
  const status = $('auth-status');
  if (!status) return;
  const id = ($('auth-provider').value || '').trim();
  status.className = 'auth-status';
  status.textContent = '';
  if (!id) {
    const n = Object.keys(authProviders).length;
    status.textContent = n
      ? 'Type or pick a provider — suggestions appear as you type.'
      : '';
    return;
  }
  const p = authProviders[id];
  const cat = p && p.models ? ` · ${p.models} models in its catalog` : '';
  if (!p) {
    status.textContent = `${id}: not a known pi provider id (any id is accepted) — no credentials stored.`;
    status.classList.add('warn');
  } else if (p.auth === 'key') {
    status.textContent = `${p.name || id} — logged in with an API key ${p.keyMasked || ''}${cat}`;
    status.classList.add('ok');
  } else if (p.auth === 'oauth') {
    status.textContent = `${p.name || id} — logged in via OAuth / subscription${cat}`;
    status.classList.add('ok');
  } else if (p.auth === 'other') {
    status.textContent = `${p.name || id} — configured in auth.json, but not an API key login (cannot be removed here)${cat}`;
    status.classList.add('warn');
  } else {
    status.textContent = `${p.name || id} — no credentials stored yet${cat}${p.custom ? ' (custom provider)' : ''}`;
  }
}

// Only the providers that actually have credentials — usually a short list.
function renderAuthLoggedIn() {
  const list = $('auth-logged-in');
  if (!list) return;
  list.innerHTML = '';
  const ids = Object.keys(authProviders).filter((id) => authProviders[id].auth !== 'none');
  if (!ids.length) {
    list.appendChild(el('div', 'prov-empty', 'no credentials stored yet'));
    return;
  }
  for (const id of ids) {
    const p = authProviders[id];
    const row = el('div', 'prov-row');
    const info = el('div', 'prov-info');
    info.appendChild(el('div', 'prov-id', p.name || id));
    const what = p.auth === 'key' ? `API key ${p.keyMasked || ''}`
      : p.auth === 'oauth' ? 'OAuth / subscription'
      : 'other configuration (protected)';
    info.appendChild(el('div', 'prov-meta', `${id} · ${what}`));
    const btn = el('button', 'btn small', p.auth === 'other' ? 'protected' : 'logout');
    if (p.auth === 'other') {
      btn.disabled = true;
      btn.title = `"${id}" holds configuration beyond a login (an env block, for example) — remove it by hand if you really mean to`;
    } else {
      btn.title = `Remove "${id}" credentials from auth.json (like /logout)`;
      btn.onclick = () => authLogout(id);
    }
    row.append(info, btn);
    row.onclick = (e) => {
      if (e.target === btn) return;
      $('auth-provider').value = id;
      renderAuthStatus();
      $('auth-key').focus();
    };
    list.appendChild(row);
  }
}

// Restart the shared agent so it re-reads auth.json (same mechanism the
// llama.cpp fix uses).
async function authRestartAgent() {
  toast('Restarting the agent to pick up the new credentials…');
  const wait = waitForAgentReady(60000);
  send({ bridge: 'restart' });
  await wait;
  await initSession(true);
}

async function authLogout(id) {
  if (!confirm(`Log out "${id}"?\nRemoves its credentials from auth.json (like /logout).`)) return;
  try {
    const r = await fetch(`/api/auth-login?provider=${encodeURIComponent(id)}`, { method: 'DELETE' });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
    await authRestartAgent();
    toast(`Logged out "${id}"`);
    loadAuthProviders();
    refreshModels();
  } catch (e) {
    toast(e.message, 'error');
  }
}

$('auth-provider').addEventListener('input', renderAuthStatus);
$('auth-provider').addEventListener('change', renderAuthStatus);

$('btn-auth-login').onclick = async () => {
  const id = $('auth-provider').value.trim();
  const key = $('auth-key').value.trim();
  if (!id) { toast('Enter the provider id first', 'warning'); return; }
  if (!key) { toast('Enter the API key', 'warning'); return; }
  try {
    const r = await fetch('/api/auth-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: id, key }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
    $('auth-key').value = '';
    await authRestartAgent();
    toast(`Logged in "${id}" — key saved to auth.json`);
    loadAuthProviders();
    refreshModels();
  } catch (e) {
    toast(`Login failed: ${e.message}`, 'error');
  }
};
$('btn-auth-logout').onclick = () => {
  const id = $('auth-provider').value.trim();
  if (!id) { toast('Enter the provider id first', 'warning'); return; }
  authLogout(id);
};

/* ───────────────────────── shorts feed (one-tap) ───────────────────────── */

const SHORTS_FEEDS = {
  instagram: { url: 'https://www.instagram.com/reels/', label: 'Reels' },
  tiktok: { url: 'https://www.tiktok.com/', label: 'TikTok' },
  youtube: { url: 'https://www.youtube.com/shorts/', label: 'Shorts' },
};

/* ───────────────────────── Reels / Shorts ─────────────────────────
 * Three ways to watch, depending on the platform:
 *
 *  1. NATIVE (React Native app): the page runs inside a WebView, so we can
 *     hand off to the app's native shorts sheet via window.webview.postMessage.
 *     The app loads the real feed top-level (a WebView is a full browser
 *     context, so X-Frame-Options doesn't apply) — the true seamless split.
 *
 *  2. IN-APP PANEL (browser default): a split pane inside the app that plays
 *     single videos via the official embeds (YouTube /embed/<id>, Instagram
 *     /reel/<id>/embed/, TikTok /embed/v2/<id>). The infinite feed itself
 *     can't be iframed (IG/TikTok send X-Frame-Options: DENY), so for that:
 *
 *  3. SIDE WINDOW: a popup docked flush against the right edge of the app
 *     window (zero gap) that loads the full feed — plus a plain tab fallback.
 * ─────────────────────────────────────────────────────────────────── */
/* Check at call time (not load time): react-native-webview injects the
 * bridge during page load, and a lazy check is immune to load-order races. */
function nativeBridge() {
  if (window.webview && typeof window.webview.postMessage === 'function') return window.webview;
  if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') return window.ReactNativeWebView;
  return null;
}

let reelsWin = null;           // side-window (full feed) handle
let reelsFeed = 'instagram';   // active feed in the in-app panel
const reelsLinks = {};         // last pasted link per feed

function showReelsPill(label) {
  const pill = $('reels-pill');
  if (!pill) return;
  pill.querySelector('span').textContent = `◧ ${label}`;
  pill.classList.remove('hidden');
}
function hideReelsPill() {
  const pill = $('reels-pill');
  if (pill) pill.classList.add('hidden');
}

/* Build an official embed URL from a pasted share link. */
function embedUrlFor(feed, raw) {
  const u = (raw || '').trim();
  if (!u) return null;
  let m;
  if (feed === 'youtube') {
    m = u.match(/(?:youtube\.com\/(?:shorts|embed|live)\/|youtu\.be\/|youtube\.com\/watch\?(?:[^&]*&)*v=)([A-Za-z0-9_-]{6,20})/);
    return m ? `https://www.youtube.com/embed/${m[1]}?autoplay=1` : null;
  }
  if (feed === 'instagram') {
    m = u.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
    return m ? `https://www.instagram.com/reel/${m[1]}/embed/` : null;
  }
  if (feed === 'tiktok') {
    m = u.match(/tiktok\.com\/.*\/video\/(\d+)/);
    return m ? `https://www.tiktok.com/embed/v2/${m[1]}` : null;
  }
  return null;
}

function setReelsFeed(feed) {
  reelsFeed = feed;
  for (const b of $('reels-tabs').querySelectorAll('.rtab'))
    b.classList.toggle('active', b.dataset.feed === feed);
  $('reels-link').value = reelsLinks[feed] || '';
  const link = reelsLinks[feed];
  const src = link ? embedUrlFor(feed, link) : null;
  // In the app the panel is backed by a real browser surface, so switching tab
  // just repoints it -- no iframe, no popup.
  if (nativeFeedOpen) { openNativeFeed(feed); return; }
  if (src) loadReelsVideo(src);
  else {
    const v = $('reels-video');
    v.innerHTML = '';
    const ph = el('div', 'reels-placeholder');
    ph.innerHTML = `<p>Paste a ${SHORTS_FEEDS[feed].label} link above to play it right here — no new tab.</p>` +
      `<p class="hint">The full infinite feed needs its own browsing context: the sites send <code>X-Frame-Options: DENY</code>, so an iframe is refused. <b>Open the feed</b> below and it loads for real, docked beside the app.</p>` +
      `<div class="reels-placeholder-actions"><button class="btn small primary" data-reels-open="feed">open ${SHORTS_FEEDS[feed].label} feed</button></div>`;
    v.appendChild(ph);
    const openBtn = ph.querySelector('[data-reels-open="feed"]');
    if (openBtn) openBtn.onclick = () => openReelsWindow(feed);
  }
}

function loadReelsVideo(src) {
  const v = $('reels-video');
  v.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'no-referrer';
  v.appendChild(iframe);
}

/* Browser 'panel' mode: the same toggle the Reels button uses, kept as a named
 * entry point because the reels pill and the settings menu call it too. */
function toggleReelsPanel() {
  const panel = $('reels-panel');
  if (panel.classList.contains('hidden')) {
    setReelsFeed(SHORTS_FEEDS[SET.shortsProvider || 'instagram'] ? (SET.shortsProvider || 'instagram') : 'instagram');
    $('reels-link').focus();
    showReels(reelsFeed);
  } else {
    hideReels();
  }
}

/* ── docked native feed (Windows app) ──────────────────────────────
 *
 * In the app the page runs inside WebView2, which gives us something a browser
 * cannot: a second real browser surface we can place anywhere in the window.
 * So instead of iframing a feed (Instagram and TikTok refuse that with
 * X-Frame-Options: DENY) or opening a popup, we park a genuine Chromium surface
 * exactly over this panel's rectangle. The panel stays the layout -- drag the
 * splitter and the feed follows -- and the site sees a top-level browsing
 * context, so the infinite feed loads normally.
 *
 * Messages go to windows/PiAgent/WebView2Module.h as
 *   piagent|shorts|open|x|y|w|h|url
 *   piagent|shorts|rect|x|y|w|h
 *   piagent|shorts|close
 * with x/y relative to the panel (straight from getBoundingClientRect).
 */
function webView2Host() {
  const c = window.chrome;
  return c && c.webview && typeof c.webview.postMessage === 'function' ? c.webview : null;
}

let nativeFeedOpen = false;

function panelRect() {
  const r = $('reels-panel').getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

function openNativeFeed(feed) {
  const host = webView2Host();
  if (!host) return false;
  const f = SHORTS_FEEDS[feed] || SHORTS_FEEDS.instagram;
  const r = panelRect();
  if (r.w < 40 || r.h < 40) return false;
  host.postMessage(`piagent|shorts|open|${r.x}|${r.y}|${r.w}|${r.h}|${f.url}`);
  nativeFeedOpen = true;
  $('reels-video').classList.add('native-feed');
  return true;
}

function syncNativeFeed() {
  const host = webView2Host();
  if (!host || !nativeFeedOpen) return;
  if ($('reels-panel').classList.contains('hidden')) { closeNativeFeed(); return; }
  const r = panelRect();
  if (r.w < 40 || r.h < 40) return;
  host.postMessage(`piagent|shorts|rect|${r.x}|${r.y}|${r.w}|${r.h}`);
}

function closeNativeFeed() {
  if (!nativeFeedOpen) return;
  nativeFeedOpen = false;
  const host = webView2Host();
  if (host) host.postMessage('piagent|shorts|close');
  const v = $('reels-video');
  if (v) v.classList.remove('native-feed');
}

/* Side window for the full infinite feed: docked flush against the right
 * edge of the app window (same height, zero gap) so it reads like a split
 * pane. A top-bar pill tracks it. Falls back to a tab when blocked. */
function openReelsWindow(feed) {
  const f = SHORTS_FEEDS[feed] || SHORTS_FEEDS.instagram;
  const w = Math.min(460, Math.max(360, Math.round(window.outerWidth * 0.42)));
  const h = Math.max(480, Math.min(window.outerHeight, window.screen.height));
  const left = Math.max(0, window.screenX + window.outerWidth - w);
  const top = Math.max(0, window.screenY);
  if (reelsWin && !reelsWin.closed) {
    try {
      const cur = reelsWin.location.href || '';
      if (!cur.startsWith(f.url.slice(0, 25))) reelsWin.location.href = f.url;
    } catch { reelsWin.location.href = f.url; }
    reelsWin.focus();
  } else {
    reelsWin = window.open(f.url, 'pi_reels_feed',
      'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top);
    if (!reelsWin) { // popup blocked by the browser
      window.open(f.url, '_blank');
      toast('Popup blocked — opened in a tab instead', 'warning');
      return;
    }
  }
  showReelsPill(f.label);
  toast(`${f.label} feed opened in the side window`);
}

function showReels(provider) {
  const panel = $('reels-panel');
  panel.classList.remove('hidden');
  setReelsFeed(provider || 'instagram');
  // Remember it: a reload (or a native shell that rebuilds its surface) brings
  // the panel back instead of silently closing it.
  SET.reelsOpen = true;
  saveSettings();
  // Windows app: back the panel with a real Chromium surface instead of the
  // placeholder. No-op in a plain browser.
  openNativeFeed(reelsFeed);
}

function hideReels() {
  autoShortsOpened = false;   // the user (or the auto-hook) took it down
  $('reels-panel').classList.add('hidden');
  SET.reelsOpen = false;
  saveSettings();
  closeNativeFeed();
}

/* ── auto-open the feed while the agent works (settings → shorts) ──
 * Only closes what it opened itself, so a feed the user opened by hand is
 * never yanked away. Keyed off agent_start/agent_settled: settled means pi
 * will not continue on its own (no retry, compaction or queued follow-up), so
 * "the run is finished" really means finished. */
let autoShortsOpened = false;

function reelsHidden() {
  const panel = $('reels-panel');
  if (panel && !panel.classList.contains('hidden')) return false;
  if (reelsWin && !reelsWin.closed) return false;
  return true;
}

function autoOpenShortsIfEnabled() {
  if (!SET.shortsAutoOpen || autoShortsOpened) return;
  if (!SHORTS_FEEDS[SET.shortsProvider || 'instagram']) return; // 'none' → nothing to show
  if (!reelsHidden()) return;                                   // already open
  autoShortsOpened = true;
  openShorts();
}

function autoCloseShortsIfOurs() {
  if (!autoShortsOpened) return;
  autoShortsOpened = false;
  hideReels();
  if (reelsWin && !reelsWin.closed) {
    try { reelsWin.close(); } catch { /* ignore */ }
    reelsWin = null;
  }
}

/* The Reels button is a TOGGLE: first press docks the feed, second press puts it
 * away. It used to re-open (and therefore reload) the feed on every press. */
function toggleReels() {
  const panel = $('reels-panel');
  if (panel.classList.contains('hidden')) showReels(SET.shortsProvider || 'instagram');
  else hideReels();
}

function openShorts() {
  const provider = SET.shortsProvider || 'instagram';
  // Native (React Native) mode: open the app's native shorts sheet.
  const bridge = nativeBridge();
  if (bridge) {
    bridge.postMessage(JSON.stringify({ type: 'openShorts', provider }));
    return;
  }
  // WebView2 app: dock the feed inside the window, next to the chat.
  if (webView2Host()) { toggleReels(); return; }
  const mode = SET.shortsMode || 'panel';
  if (mode === 'tab') { reelsWin = window.open((SHORTS_FEEDS[provider] || SHORTS_FEEDS.instagram).url, '_blank'); return; }
  if (mode === 'window') { openReelsWindow(provider); return; }
  toggleReelsPanel();
}

$('btn-reels').onclick = openShorts;
$('btn-reels-close').addEventListener('click', hideReels);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('reels-panel').classList.contains('hidden')) hideReels();
});
for (const b of $('reels-tabs').querySelectorAll('.rtab'))
  b.addEventListener('click', () => setReelsFeed(b.dataset.feed));

function playReelsLink() {
  const link = $('reels-link').value;
  const src = embedUrlFor(reelsFeed, link);
  if (!src) { toast('Couldn\'t find a video id in that link', 'error'); return; }
  reelsLinks[reelsFeed] = link;
  loadReelsVideo(src);
}
$('btn-reels-play').addEventListener('click', playReelsLink);
$('reels-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') playReelsLink(); });
$('btn-reels-feed').addEventListener('click', () => {
  if (openNativeFeed(reelsFeed)) return;
  openReelsWindow(reelsFeed);
});
// Same action from the placeholder inside the panel, so "I want the real feed"
// is one tap from where the user actually is.
const reelsFeedInline = $('btn-reels-feed-inline');
if (reelsFeedInline) {
  reelsFeedInline.addEventListener('click', () => {
    if (openNativeFeed(reelsFeed)) return;
    openReelsWindow(reelsFeed);
  });
}

/* Drag the panel's left edge to resize it. The feed is a real window surface,
 * so it has to be told the new rectangle -- that is what syncNativeFeed() is
 * for, and a ResizeObserver below catches every other layout change too. */
const reelsResize = $('reels-resize');
if (reelsResize) {
  let dragging = false;
  reelsResize.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { reelsResize.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    reelsResize.classList.add('dragging');
    e.preventDefault();
  });
  const move = (e) => {
    if (!dragging) return;
    const panel = $('reels-panel');
    const max = Math.max(320, window.innerWidth - 360);
    const w = Math.max(320, Math.min(max, window.innerWidth - e.clientX));
    panel.style.width = w + 'px';
    syncNativeFeed();
  };
  reelsResize.addEventListener('pointermove', move);
  window.addEventListener('pointermove', move);
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    reelsResize.classList.remove('dragging');
    // Remember the width - the panel used to snap back to its narrow default
    // on every launch.
    SET.reelsWidth = Math.round($('reels-panel').getBoundingClientRect().width);
    saveSettings();
    syncNativeFeed();
  };
  reelsResize.addEventListener('pointerup', stop);
  window.addEventListener('pointerup', stop);
  applyReelsWidth();
}

/* The saved panel width, or a wider default than the old 400px so the feed has
 * room from the start. */
function applyReelsWidth() {
  const panel = $('reels-panel');
  if (!panel) return;
  const max = Math.max(320, window.innerWidth - 360);
  const want = Number(SET.reelsWidth) > 0 ? Number(SET.reelsWidth) : Math.round(window.innerWidth * 0.42);
  panel.style.width = `${Math.max(340, Math.min(max, want))}px`;
}

if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => syncNativeFeed());
  ro.observe($('reels-panel'));
}
window.addEventListener('resize', () => syncNativeFeed());

// The docked feed is a window this page does not own, so a reload would leave it
// behind. Clear any orphan on startup, and try to close ours on the way out.
if (webView2Host()) {
  webView2Host().postMessage('piagent|shorts|close');
  window.addEventListener('beforeunload', () => {
    try { webView2Host().postMessage('piagent|shorts|close'); } catch { /* going away */ }
  });
}

$('reels-pill').addEventListener('click', () => {
  if (reelsWin && !reelsWin.closed) { try { reelsWin.close(); } catch { /* ignore */ } }
  reelsWin = null;
  hideReelsPill();
});
/* Watchdog: hide the pill when the side window is closed from its own UI. */
setInterval(() => {
  if (reelsWin && reelsWin.closed) { reelsWin = null; hideReelsPill(); }
}, 1000);

/* ── in-app dialogs ───────────────────────────────────────────────────────
 * confirm() and prompt() look like a browser warning bolted onto the page. This
 * is the same shape as the settings dialog, so confirmations read as part of the
 * app. Returns a promise: the resolved value is the field values object, or null
 * when cancelled. */
function askDialog(opts = {}) {
  return new Promise((resolve) => {
    const dlg = $('ask-dialog');
    if (!dlg) { resolve(null); return; }
    $('ask-title').textContent = opts.title || 'Are you sure?';
    const body = $('ask-body');
    body.innerHTML = '';
    if (opts.body) body.appendChild(el('p', 'ask-text', opts.body));
    const fields = opts.fields || [];
    const inputs = {};
    for (const f of fields) {
      const row = el('label', 'ask-row');
      row.appendChild(el('span', 'ask-label', f.label));
      const input = el('input');
      input.type = 'text';
      input.value = f.value || '';
      input.placeholder = f.placeholder || '';
      input.autocomplete = 'off';
      row.appendChild(input);
      body.appendChild(row);
      inputs[f.name] = input;
    }
    if (opts.hint) body.appendChild(el('p', 'ask-hint', opts.hint));
    $('ask-ok').textContent = opts.okLabel || 'ok';
    $('ask-ok').classList.toggle('danger', opts.danger === true);
    $('ask-cancel').textContent = opts.cancelLabel || 'cancel';
    const done = (value) => {
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onClose = () => resolve(null);
    dlg.addEventListener('close', onClose);
    $('ask-ok').onclick = () => {
      const out = {};
      for (const f of fields) out[f.name] = inputs[f.name].value.trim();
      if (opts.require) {
        const missing = opts.require.find((n) => !out[n]);
        if (missing) { inputs[missing].focus(); return; }
      }
      done(out);
    };
    $('ask-cancel').onclick = () => done(null);
    const first = fields.length ? inputs[fields[0].name] : $('ask-ok');
    if (!dlg.open) dlg.showModal();
    setTimeout(() => first.focus(), 30);
  });
}

/* ── context menus ────────────────────────────────────────────────────────
 * Right click a session in the sidebar, or a message in the transcript. Both use
 * the same dropdown component as the model picker. */

function openSessionMenu(s, anchor) {
  const cur = S.state.sessionFile;
  const isCurrent = !!(cur && (s.path === cur || s.fileName === String(cur).split(/[\\/]/).pop()));
  openMenu(anchor, [
    { label: 'open', active: isCurrent, onPick: () => switchToSession(s.path) },
    { label: 'export…', hint: 'save the .jsonl wherever you want', onPick: () => exportSession(s) },
    // The tree comes from the agent, so it is only meaningful for the session
    // the agent has loaded - a read-only view would list the wrong branches.
    ...(isCurrent ? [{ label: 'branches…', hint: 'fork points in this session', sub: true, onPick: () => openBranchesMenu(s, anchor) }] : []),
    { sep: true },
    { label: 'delete…', hint: 'removes the file from disk', danger: true, onPick: () => deleteSession(s) },
  ], { title: 'session', width: 330, align: 'right' });
}

/* Download a session file. showSaveFilePicker is a real "where do you want it"
 * dialog; the plain anchor fallback still saves to the download folder. */
async function exportSession(s) {
  const url = `/api/session-file?path=${encodeURIComponent(s.path)}`;
  const name = String(s.fileName || 'session.jsonl');
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'pi session', accept: { 'application/jsonl': ['.jsonl'] } }],
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`bridge said ${res.status}`);
      const blob = await res.blob();
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      toast(`Exported ${name}`);
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // cancelled in the dialog
  }
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Exporting ${name}`);
}

async function deleteSession(s) {
  const ok = await askDialog({
    title: 'Delete this session?',
    body: `${s.name}\n${s.path}`,
    hint: 'The file is removed from disk. This cannot be undone.',
    okLabel: 'delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await fetch('/api/session-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: s.path }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'delete failed');
    if (S.state.sessionFile && s.path === S.state.sessionFile) {
      // Deleting a fork used to leave you on a brand new empty session. Go back
      // to where it was forked from when the file says, otherwise to the most
      // recent other session - either way, not a blank one.
      const parent = await sessionParent(s.path);
      const rest = (await fetch('/api/sessions').then((x) => x.json()).catch(() => ({ sessions: [] })).then((d2) => (d2.sessions || [])))
        .filter((x) => x.path !== s.path)
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      const target = parent && rest.some((x) => x.path === parent) ? parent : (rest[0] && rest[0].path);
      if (target) {
        await switchToSession(target);
      } else {
        toast('That was the only session - starting a new one', 'warning');
        await rpc({ type: 'new_session' }).catch(() => {});
        await initSession(false);
      }
    }
    await refreshSessions();
    toast(`Deleted ${s.name}`);
  } catch (e) {
    toast(`Delete failed: ${e.message}`, 'error');
  }
}

/* The session a fork came from, if the file records it. */
async function sessionParent(sessionPath) {
  try {
    const d = await fetchSession(sessionPath);
    return d.parent || null;
  } catch { return null; }
}

/* Branch points of the open session (pi keeps branches in one file as a tree).
 * There is no RPC for moving the active leaf, so choosing a branch point means
 * forking there - which is how a branch gets started in the first place. */
async function openBranchesMenu(s, anchor) {
  let tree = null, leafId = null;
  try {
    const d = await rpc({ type: 'get_tree' });
    tree = d && d.tree;
    leafId = d && d.leafId;
  } catch { /* older agent */ }
  if (!tree || !tree.length) { toast('This session has no branches yet', 'warning'); return; }
  const describe = (entry) => {
    const m = entry && entry.message;
    const text = m ? String((m.content || []).map((c) => c.text || '').join(' ')).replace(/\s+/g, ' ').trim() : '';
    return `${m ? m.role : (entry && entry.type) || 'entry'}: ${text.slice(0, 70) || entry.id}`;
  };
  const items = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      const kids = n.children || [];
      const isLeaf = kids.length === 0;
      if (isLeaf || kids.length > 1) {
        items.push({
          label: `${isLeaf ? (n.entry.id === leafId ? '● ' : '○ ') : '⑂ '}${describe(n.entry)}`,
          hint: isLeaf ? 'branch end' : `${kids.length} branches`,
          active: n.entry.id === leafId,
          onPick: () => forkAt(n.entry.id, describe(n.entry)),
        });
      }
      if (kids.length) walk(kids);
    }
  };
  walk(tree);
  if (!items.length) { toast('Nothing to switch between yet', 'warning'); return; }
  openMenu(anchor, items, {
    title: 'branches - picking one starts a new branch from there',
    width: 420,
    search: 'filter branch points…',
    align: 'right',
  });
}

async function forkAt(entryId, text) {
  const ok = await askDialog({
    title: 'Start a new branch?',
    body: text,
    hint: 'The conversation continues from this point. The old continuation stays in the session file.',
    okLabel: 'fork',
  });
  if (!ok) return;
  try {
    // pi forks *before* the message you picked and returns its text so the client
    // can send it again - that is what its own UI does with the reply. Ignoring
    // it left the new branch ending one turn earlier than the turn you clicked,
    // which is why every fork looked like it came from the wrong turn.
    const res = await rpc({ type: 'fork', entryId });
    await initSession(false);
    const again = res && typeof res.text === 'string' ? res.text.trim() : '';
    if (again && !res.cancelled) {
      toast('Forked - continuing from here');
      rpc({ type: 'prompt', message: res.text }).catch((e) => toast(`Continue failed: ${e.message}`, 'error'));
    } else {
      toast('Forked - continue from here');
    }
  } catch (e) {
    toast(`Fork failed: ${e.message}`, 'error');
  }
}

/* Right-click a message. On a user turn there is a fork entry for it; on an
 * assistant turn the fork point is the user message that started it, so walk
 * back to the nearest one. Reading a session the agent has not loaded cannot be
 * forked in place - the agent has to switch to it first, which the menu says. */
function openTurnMenu(node, at) {
  const m = node._msg || null;
  let forkNode = node;
  if (!forkNode.dataset.fork) {
    let prev = forkNode.previousElementSibling;
    while (prev && !prev.dataset.fork) prev = prev.previousElementSibling;
    forkNode = prev || null;
  }
  const entryId = forkNode && forkNode.dataset.fork ? forkNode.dataset.fork : null;
  const items = [];
  if (entryId) {
    const elsewhere = !!S.viewSession;
    items.push({
      label: elsewhere ? 'open this session and fork here' : 'fork from here',
      hint: elsewhere ? 'the agent has to load it first' : 'new branch at this message',
      onPick: () => (elsewhere ? forkInOtherSession(entryId, forkNode.dataset.forktext || '') : forkAt(entryId, forkNode.dataset.forktext || '')),
    });
  }
  if (m && m.role === 'assistant' && !S.viewSession) items.push({ label: 'clone session here', hint: 'copy the session up to now', onPick: () => cloneHere() });
  const md = node.querySelector('.md');
  const text = md ? md.innerText : '';
  if (text) {
    if (items.length) items.push({ sep: true });
    items.push({ label: 'copy text', onPick: () => { navigator.clipboard.writeText(text); toast('Copied'); } });
    items.push({ label: 'speak', onPick: () => speak(stripMarkdown(text)) });
  }
  if (!items.length) return;
  openMenu(node.querySelector('.who') || node, items, { title: 'message', width: 320, at });
}

/* Forking in a session the agent has not loaded: switch to it, then fork. */
async function forkInOtherSession(entryId, text) {
  const target = S.viewSession;
  if (!target) return;
  const ok = await askDialog({
    title: 'Open that session and fork?',
    body: text,
    hint: 'The agent switches to it first - it can only fork in the session it has loaded.',
    okLabel: 'fork',
  });
  if (!ok) return;
  try {
    await rpc({ type: 'switch_session', sessionPath: target });
    S.state.sessionFile = target;
    S.viewSession = null;
    S.liveDetached = null;
    await initSession(false);
    const res = await rpc({ type: 'fork', entryId });
    await initSession(false);
    const again = res && typeof res.text === 'string' ? res.text.trim() : '';
    if (again && !res.cancelled) {
      toast('Forked - continuing from here');
      rpc({ type: 'prompt', message: res.text }).catch((e) => toast(`Continue failed: ${e.message}`, 'error'));
    } else {
      toast('Forked - continue from here');
    }
  } catch (e) {
    toast(`Fork failed: ${e.message}`, 'error');
  }
}

async function cloneHere() {
  try {
    await rpc({ type: 'clone' });
    await initSession(false);
    toast('Cloned into a new session');
  } catch (e) {
    toast(`Clone failed: ${e.message}`, 'error');
  }
}

/* ── instances ────────────────────────────────────────────────────────────
 * Other pi agents (other machines, or a second bridge on this one) in the
 * sidebar. Switching opens that instance's own WebUI, so its name, picture and
 * every other setting stay with it - each bridge keeps its own settings file.
 * The dot comes from /api/health, the one endpoint that answers cross-origin. */
function localInstance() { return { id: 'local', name: (SET.agentName || '').trim() || 'this machine', url: location.origin }; }
function allInstances() {
  const out = [localInstance()];
  for (const i of SET.instances || []) if (i && i.url) out.push(i);
  return out;
}
function instanceStatus(url) {
  return S.instanceStatus[url === location.origin ? 'local' : url] || null;
}

async function pollInstances() {
  await Promise.all(allInstances().map(async (inst) => {
    const key = inst.url === location.origin ? 'local' : inst.url;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const d = await fetch(`${inst.url}/api/health`, { signal: ctl.signal, cache: 'no-store' }).then((r) => r.json());
      clearTimeout(t);
      S.instanceStatus[key] = { ok: !!d.ok, busy: !!d.busy, name: d.name || null, at: Date.now() };
    } catch {
      S.instanceStatus[key] = { ok: false, busy: false, at: Date.now() };
    }
  }));
  updateInstanceBtn();
  if (openMenuEl && openMenuEl._instances) openInstanceMenu(openMenuEl._anchor, true);
}

function updateInstanceBtn() {
  const btn = $('btn-instance');
  if (!btn) return;
  const extra = allInstances().length - 1;
  btn.textContent = ((SET.agentName || '').trim() || 'this machine') + (extra ? ` +${extra}` : '');
  btn.title = 'pi agent instances - click to switch or add another one';
}

function openInstanceMenu(anchor, force) {
  const items = [];
  for (const inst of allInstances()) {
    const st = instanceStatus(inst.url);
    const here = inst.url === location.origin;
    items.push({
      label: (here ? '● ' : '') + inst.name + (st && st.name ? `  (${st.name})` : ''),
      hint: here ? 'this window' : String(inst.url).replace(/^https?:\/\//, ''),
      dot: st && st.busy ? 'live-dot' : (st && st.ok ? null : 'off-dot'),
      active: here,
      onPick: () => switchInstance(inst),
    });
  }
  items.push({ sep: true });
  items.push({ label: 'add another pi agent…', hint: 'other machine or port', onPick: () => addInstance() });
  if ((SET.instances || []).length) {
    items.push({ sep: true, group: 'remove' });
    for (const i of SET.instances) {
      items.push({
        label: `remove ${i.name}`,
        hint: i.url.replace(/^https?:\/\//, ''),
        danger: true,
        onPick: () => {
          SET.instances = (SET.instances || []).filter((x) => x.id !== i.id);
          saveSettings();
          toast(`Removed ${i.name}`);
        },
      });
    }
  }
  const menu = openMenu(anchor, items, { title: 'pi agents', width: 360, force });
  if (menu) menu._instances = true;
}

function switchInstance(inst) {
  if (inst.url === location.origin) return;
  toast(`Switching to ${inst.name}…`);
  // Tell the other instance where we came from: without it you could switch away
  // and had no way back, because its list knew nothing about this one.
  const me = SET.instanceName || 'this machine';
  const sep = inst.url.includes('?') ? '&' : '?';
  location.href = `${inst.url}${sep}from=${encodeURIComponent(location.origin)}&fromName=${encodeURIComponent(me)}`;
}

/* An instance opened through the switcher arrives with ?from=… - add it to the
 * list so the switcher can go back. Runs once, from updateInstanceBtn. */
let absorbedFrom = false;
function absorbFromParam() {
  if (absorbedFrom) return;
  let params;
  try { params = new URL(location.href).searchParams; } catch { absorbedFrom = true; return; }
  const from = params.get('from');
  if (!from) { absorbedFrom = true; return; }
  // Only now is it safe to touch the list: called before the settings arrive,
  // SET was replaced wholesale a moment later and the new entry was lost.
  absorbedFrom = true;
  let base;
  try { base = new URL(from).origin; } catch { return; }
  const name = params.get('fromName') || base;
  if (base && base !== location.origin && !allInstances().some((i) => i.url === base)) {
    SET.instances = [...(SET.instances || []), { id: `i${Date.now().toString(36)}`, name, url: base }];
    saveSettings();
    toast(`Added "${name}" to the instance list so you can switch back`);
  }
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
}

function addInstance() {
  askDialog({
    title: 'Add another pi agent',
    body: 'Its WebUI address. Add an SSH tunnel or start that bridge with PI_WEBUI_HOST=0.0.0.0 to reach another machine.',
    fields: [
      { name: 'name', label: 'name', placeholder: 'laptop' },
      { name: 'url', label: 'address', placeholder: 'http://192.168.1.20:3080', value: 'http://' },
    ],
    require: ['name', 'url'],
    okLabel: 'add',
  }).then((res) => {
    if (!res) return;
    let url = String(res.url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) url = `http://${url}`;
    let base;
    try { base = new URL(url).origin; } catch { toast('That is not a valid address', 'error'); return; }
    if (allInstances().some((i) => i.url === base)) { toast('That instance is already in the list', 'warning'); return; }
    SET.instances = [...(SET.instances || []), { id: `i${Date.now().toString(36)}`, name: res.name, url: base }];
    saveSettings();
    updateInstanceBtn();
    toast(`${res.name} added - click it to switch`);
    pollInstances().catch(() => {});
  });
}

/* ───────────────────────── boot ───────────────────────── */

wireTypeAnywhere();
applySettings();
populateTtsVoiceSelect();
loadServerSettings().then(() => maybeShowSetup());
connect();

/* thinking level: the button opens the same dropdown as the model picker */
if ($('thinking-btn')) $('thinking-btn').onclick = (e) => { e.stopPropagation(); openThinkingMenu(); };

/* right-click menus: a session row (wired in renderSessions) or a message */
chat.addEventListener('contextmenu', (e) => {
  const node = e.target.closest('.msg');
  if (!node || node.classList.contains('compaction')) return;
  e.preventDefault();
  openTurnMenu(node, { x: e.clientX, y: e.clientY });
});

/* instances: the button opens the switcher, and the dots refresh in the
 * background so a busy agent on another machine shows up on its own */
if ($('btn-instance')) {
  $('btn-instance').onclick = (e) => { e.stopPropagation(); openInstanceMenu($('btn-instance')); };
  updateInstanceBtn();
  setTimeout(() => { pollInstances().catch(() => {}); }, 1500);
  setInterval(() => { pollInstances().catch(() => {}); }, 8000);
}

// Reopen the shorts panel if it was open when the page last unloaded.
if (SET.reelsOpen && SHORTS_FEEDS[SET.shortsProvider || 'instagram']) {
  setTimeout(() => { if (reelsHidden()) showReels(SET.shortsProvider); }, 600);
}
