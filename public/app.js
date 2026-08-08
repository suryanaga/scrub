'use strict';

/* scrub — click the transcript to hear it, double-click to fix it. */

const $ = (s) => document.querySelector(s);
const audio = $('#audio');
const doc = $('#doc');

const state = {
  format: 'md',
  blocks: [],
  mtime: 0,
  pendingText: null,
  saveTimer: null,
  editingId: null,
  activeId: null,
  lastUserScroll: 0,
  matches: [],
  matchIdx: -1,
};

/* ============================================================ parsing */

const MARKER = /^<!--t:([0-9]+(?:\.[0-9]+)?)-->\n?/;

let nextId = 1;

function parseMarkdown(text) {
  // Split on blank lines, keeping the exact separators so saving round-trips cleanly.
  const parts = text.split(/(\n[ \t]*(?:\n[ \t]*)*\n)/);
  const blocks = [];
  for (let i = 0; i < parts.length; i += 2) {
    const chunk = parts[i];
    const sep = parts[i + 1] || '';
    if (chunk === '' && sep === '') continue;
    let body = chunk;
    let t = null;
    let marker = '';
    const m = MARKER.exec(body);
    if (m) { t = parseFloat(m[1]); marker = m[0]; body = body.slice(m[0].length); }
    blocks.push({ id: 'b' + nextId++, body, sep, marker, t, tEnd: null });
  }
  return blocks;
}

function serializeMarkdown(blocks) {
  return blocks.map((b) => (b.t != null ? `<!--t:${round(b.t)}-->\n` : '') + b.body + b.sep).join('');
}

function parseTime(s) {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s) || /(\d+):(\d{2})[,.](\d{1,3})/.exec(s);
  if (!m) return null;
  if (m.length === 5) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  return +m[1] * 60 + +m[2] + +m[3] / 1000;
}

function fmtSrtTime(sec) {
  const ms = Math.round((sec % 1) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`;
}

let subTrailing = '\n'; // whitespace at EOF, kept so a no-op save is a no-op

function parseSubtitles(text) {
  const isVtt = /^WEBVTT/.test(text.trim());
  subTrailing = (/\s*$/.exec(text) || ['\n'])[0].replace(/^[^\n]*/, '') || '\n';
  const chunks = text.replace(/^WEBVTT[^\n]*\n/, '').trim().split(/\n[ \t]*\n/);
  const blocks = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    let i = 0;
    if (!lines[i].includes('-->')) i++; // optional cue number
    if (!lines[i] || !lines[i].includes('-->')) continue;
    const [a, b] = lines[i].split('-->');
    const t = parseTime(a);
    const tEnd = parseTime(b);
    const body = lines.slice(i + 1).join('\n');
    blocks.push({ id: 'b' + nextId++, body, sep: '\n\n', marker: '', t, tEnd, isVtt });
  }
  return blocks;
}

function serializeSubtitles(blocks) {
  const isVtt = state.format === 'vtt';
  const sep = isVtt ? '.' : ',';
  const body = blocks
    .map((b, i) => {
      const time = `${fmtSrtTime(b.t).replace(',', sep)} --> ${fmtSrtTime(b.tEnd).replace(',', sep)}`;
      return `${i + 1}\n${time}\n${b.body}`;
    })
    .join('\n\n');
  return (isVtt ? 'WEBVTT\n\n' : '') + body + subTrailing;
}

const isSub = () => state.format === 'srt' || state.format === 'vtt';
const serialize = () => (isSub() ? serializeSubtitles(state.blocks) : serializeMarkdown(state.blocks));
const round = (n) => Math.round(n * 100) / 100;

/* Fill in tEnd for markdown blocks from the next timed block. */
function linkTimes() {
  if (isSub()) return;
  let next = null;
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b.t != null) { b.tEnd = next; next = b.t; }
  }
}

/* ============================================================ rendering */

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\[\?([^\]]{1,40})\]/g, '<mark class="flag">[?$1]</mark>');
  return out;
}

function renderTable(lines) {
  const rows = lines
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  const head = rows[0];
  const body = rows.slice(2); // row 1 is the |---|---| separator
  return (
    '<div class="tbl-wrap"><table><thead><tr>' +
    head.map((c) => `<th>${inline(c)}</th>`).join('') +
    '</tr></thead><tbody>' +
    body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
    '</tbody></table></div>'
  );
}

function renderList(lines) {
  const ordered = /^\s*\d+\./.test(lines[0]);
  const items = [];
  for (const l of lines) {
    const m = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(l);
    if (m) items.push(m[1]);
    else if (items.length) items[items.length - 1] += ' ' + l.trim();
  }
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>` + items.map((i) => `<li>${inline(i)}</li>`).join('') + `</${tag}>`;
}

function renderBody(body) {
  if (isSub()) return `<p>${inline(body.split('\n').join(' '))}</p>`;
  const trimmed = body.trim();
  if (!trimmed) return '';
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  const first = lines[0] || '';

  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return '<hr>';
  const h = /^(#{1,6})\s+(.*)$/.exec(first);
  if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
  if (lines.length >= 2 && lines.every((l) => l.trim().startsWith('|'))) return renderTable(lines);
  if (lines.every((l) => /^\s*>/.test(l)))
    return `<blockquote>${inline(lines.map((l) => l.replace(/^\s*>\s?/, '')).join(' '))}</blockquote>`;
  if (/^\s*(?:[-*+]|\d+\.)\s/.test(first)) return renderList(lines);
  return `<p>${inline(lines.join(' '))}</p>`;
}

function fmtClock(sec) {
  if (!isFinite(sec)) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

function blockHtml(b) {
  const tc = b.t != null ? `<span class="tc">${fmtClock(b.t)}</span>` : '';
  return tc + renderBody(b.body);
}

function render() {
  linkTimes();
  doc.innerHTML = '';
  for (const b of state.blocks) {
    const el = document.createElement('div');
    el.className = 'blk' + (b.t != null ? ' timed' : '');
    el.dataset.id = b.id;
    el.innerHTML = blockHtml(b);
    doc.appendChild(el);
  }
}

function rerenderBlock(id) {
  const b = byId(id);
  const el = doc.querySelector(`[data-id="${id}"]`);
  if (!b || !el) return;
  linkTimes();
  el.className = 'blk' + (b.t != null ? ' timed' : '') + (state.activeId === id ? ' active' : '');
  el.innerHTML = blockHtml(b);
}

const byId = (id) => state.blocks.find((b) => b.id === id);

/* ============================================================ seeking */

function caretFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

/* Markdown blocks carry one timestamp each, so interpolate across the
   paragraph by where in the text you clicked. Speech rate is near enough
   constant that this lands within a second or two. */
function timeAtPoint(el, ev) {
  const b = byId(el.dataset.id);
  if (!b || b.t == null) return null;
  const end = b.tEnd != null ? b.tEnd : b.t + 10;
  const span = Math.max(0, end - b.t);
  if (span === 0) return b.t;

  let frac = 0;
  const caret = caretFromPoint(ev.clientX, ev.clientY);
  if (caret && el.contains(caret.node)) {
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.setEnd(caret.node, caret.offset);
      const total = el.textContent.length;
      if (total > 0) frac = r.toString().length / total;
    } catch (_) { /* fall back to start of block */ }
  }
  return b.t + Math.min(1, Math.max(0, frac)) * span;
}

function seekTo(sec, play) {
  audio.currentTime = Math.max(0, sec);
  if (play) audio.play().catch(() => {});
}

/* ============================================================ editing */

function startEdit(id) {
  if (state.editingId) commitEdit();
  const b = byId(id);
  const el = doc.querySelector(`[data-id="${id}"]`);
  if (!b || !el) return;

  state.editingId = id;
  el.classList.add('editing');
  el.innerHTML =
    '<div class="edit-hint"><kbd>esc</kbd> cancel · <kbd>⌘⏎</kbd> or click away to save</div>';

  const ta = document.createElement('textarea');
  ta.className = 'editor';
  ta.value = b.body;
  ta.spellcheck = true;
  el.appendChild(ta);

  const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 4 + 'px'; };
  autosize();
  ta.addEventListener('input', autosize);

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(); }
  });
  ta.addEventListener('blur', () => { if (state.editingId === id) commitEdit(); });

  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function commitEdit() {
  const id = state.editingId;
  if (!id) return;
  const el = doc.querySelector(`[data-id="${id}"]`);
  const ta = el && el.querySelector('textarea');
  const b = byId(id);
  state.editingId = null;
  if (!el || !ta || !b) return;

  const changed = ta.value !== b.body;
  b.body = ta.value;
  el.classList.remove('editing');
  rerenderBlock(id);
  if (changed) scheduleSave();
}

function cancelEdit() {
  const id = state.editingId;
  if (!id) return;
  state.editingId = null;
  const el = doc.querySelector(`[data-id="${id}"]`);
  if (el) el.classList.remove('editing');
  rerenderBlock(id);
}

/* ============================================================ saving */

function setStatus(text, cls) {
  $('#status').textContent = text;
  $('#statusDot').className = 'dot' + (cls ? ' ' + cls : '');
}

function scheduleSave() {
  setStatus('unsaved', 'dirty');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, 700);
}

async function save(force) {
  clearTimeout(state.saveTimer);
  const text = serialize();
  setStatus('saving…', 'saving');
  try {
    const res = await fetch('/api/transcript', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, baseMtime: state.mtime, force: !!force }),
    });
    if (res.status === 409) {
      setStatus('conflict', 'error');
      $('#conflict').hidden = false;
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    state.mtime = data.mtime;
    $('#conflict').hidden = true;
    setStatus('saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), '');
  } catch (err) {
    setStatus('save failed: ' + err.message, 'error');
  }
}

/* ============================================================ playback ui */

let scrubbing = false;

function syncPlayButton() {
  $('#playBtn').classList.toggle('playing', !audio.paused);
}

function updateActive() {
  let active = null;
  const t = audio.currentTime;
  for (const b of state.blocks) {
    if (b.t != null && b.t <= t + 0.05) active = b.id;
    else if (b.t != null) break;
  }
  if (active === state.activeId) return;

  if (state.activeId) {
    const prev = doc.querySelector(`[data-id="${state.activeId}"]`);
    if (prev) prev.classList.remove('active');
  }
  state.activeId = active;
  if (!active) return;

  const el = doc.querySelector(`[data-id="${active}"]`);
  if (!el) return;
  el.classList.add('active');

  // Follow along, unless the reader has taken control of the scroll recently.
  if (!audio.paused && Date.now() - state.lastUserScroll > 2500 && !state.editingId) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ============================================================ search */

function runSearch(q) {
  doc.querySelectorAll('.blk.hit').forEach((el) => el.classList.remove('hit'));
  state.matches = [];
  state.matchIdx = -1;
  if (!q) { $('#searchCount').textContent = ''; return; }
  const needle = q.toLowerCase();
  state.matches = state.blocks.filter((b) => b.body.toLowerCase().includes(needle)).map((b) => b.id);
  $('#searchCount').textContent = state.matches.length ? `0/${state.matches.length}` : 'none';
  if (state.matches.length) nextMatch();
}

function nextMatch(back) {
  if (!state.matches.length) return;
  doc.querySelectorAll('.blk.hit').forEach((el) => el.classList.remove('hit'));
  state.matchIdx = back
    ? (state.matchIdx - 1 + state.matches.length) % state.matches.length
    : (state.matchIdx + 1) % state.matches.length;
  const el = doc.querySelector(`[data-id="${state.matches[state.matchIdx]}"]`);
  if (el) {
    el.classList.add('hit');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    state.lastUserScroll = Date.now();
  }
  $('#searchCount').textContent = `${state.matchIdx + 1}/${state.matches.length}`;
}

/* ============================================================ events */

doc.addEventListener('click', (ev) => {
  if (ev.target.closest('a')) return;
  const el = ev.target.closest('.blk');
  if (!el || el.classList.contains('editing')) return;
  if (String(window.getSelection())) return; // don't hijack text selection
  const t = timeAtPoint(el, ev);
  if (t == null) return;
  seekTo(t, true);
  updateActive();
});

doc.addEventListener('dblclick', (ev) => {
  const el = ev.target.closest('.blk');
  if (!el || el.classList.contains('editing')) return;
  startEdit(el.dataset.id);
});

window.addEventListener('scroll', () => { state.lastUserScroll = Date.now(); }, { passive: true });

$('#playBtn').addEventListener('click', () => {
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
});
$('#back5').addEventListener('click', () => seekTo(audio.currentTime - 5, false));
$('#fwd5').addEventListener('click', () => seekTo(audio.currentTime + 5, false));
$('#rate').addEventListener('change', (e) => { audio.playbackRate = parseFloat(e.target.value); });

$('#seek').addEventListener('input', (e) => {
  scrubbing = true;
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
});
$('#seek').addEventListener('change', () => { scrubbing = false; });

audio.addEventListener('play', syncPlayButton);
audio.addEventListener('pause', syncPlayButton);
audio.addEventListener('loadedmetadata', () => {
  $('#time').textContent = `0:00 / ${fmtClock(audio.duration)}`;
});
audio.addEventListener('timeupdate', () => {
  $('#time').textContent = `${fmtClock(audio.currentTime)} / ${fmtClock(audio.duration)}`;
  if (!scrubbing && audio.duration) $('#seek').value = (audio.currentTime / audio.duration) * 1000;
  updateActive();
});

$('#search').addEventListener('input', (e) => runSearch(e.target.value.trim()));
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); nextMatch(e.shiftKey); }
  else if (e.key === 'Escape') { e.target.blur(); }
});

$('#conflictReload').addEventListener('click', () => load());
$('#conflictForce').addEventListener('click', () => save(true));

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'TEXTAREA' || tag === 'INPUT';
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (state.editingId) commitEdit();
    save();
    return;
  }
  if (typing) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  } else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(audio.currentTime - 5, false); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(audio.currentTime + 5, false); }
  else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
});

window.addEventListener('beforeunload', (e) => {
  if (state.saveTimer) { save(); e.preventDefault(); e.returnValue = ''; }
});

/* ============================================================ boot */

async function load() {
  const cfg = await (await fetch('/api/config')).json();
  state.format = cfg.format;
  $('#fileName').textContent = cfg.transcriptName;
  document.title = cfg.transcriptName + ' — scrub';

  const data = await (await fetch('/api/transcript')).json();
  state.mtime = data.mtime;
  nextId = 1;
  state.blocks = isSub() ? parseSubtitles(data.text) : parseMarkdown(data.text);
  state.activeId = null;
  render();

  const timed = state.blocks.filter((b) => b.t != null).length;
  $('#conflict').hidden = true;
  setStatus(timed ? `${timed} timed blocks` : 'no timecodes in this file', '');
  syncPlayButton();
}

load().catch((err) => setStatus('load failed: ' + err.message, 'error'));
