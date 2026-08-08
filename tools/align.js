#!/usr/bin/env node
'use strict';

/*
 * align.js — give a hand-edited transcript its timecodes back.
 *
 * A cleaned-up transcript no longer matches the raw subtitle text word for word,
 * so we can't look timings up directly. But the *order* of the content is
 * unchanged, so we can walk both documents forward together and, for each
 * paragraph, find the window of subtitle cues it overlaps most. That lands each
 * paragraph on the right cue even though the wording has been rewritten.
 *
 * Writes `<!--t:SECONDS-->` above each matched paragraph. scrub reads those and
 * interpolates within the paragraph by click position.
 *
 * Usage:
 *   node tools/align.js --srt audio.srt --md transcript.md [options]
 *
 *   --start-after "## Heading"   only align content after this line
 *   --min-words 6                skip blocks shorter than this
 *   --threshold 0.18             minimum match score to accept
 *   --write                      write the file (default is a dry run)
 */

const fs = require('fs');
const path = require('path');

const STOP = new Set(
  ('a an and are as at be been but by do does for from had has have he her his i if in is it its ' +
   'just like me my not of on or our so than that the their them then there these they this to ' +
   'too up was we were what when which who will with would you your yeah yes no not know mean ' +
   'really quite bit kind sort thing things very much some about into more most other').split(' ')
);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else { out[a.slice(2)] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function parseTime(s) {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : null;
}

function parseCues(text) {
  const cues = [];
  for (const chunk of text.replace(/^WEBVTT[^\n]*\n/, '').trim().split(/\n[ \t]*\n/)) {
    const lines = chunk.split('\n');
    let i = lines[0].includes('-->') ? 0 : 1;
    if (!lines[i] || !lines[i].includes('-->')) continue;
    cues.push({ t: parseTime(lines[i].split('-->')[0]), text: lines.slice(i + 1).join(' ') });
  }
  return cues.filter((c) => c.t != null);
}

/* Strip markdown noise so we compare spoken words, not formatting. */
function tokens(s) {
  return s
    .toLowerCase()
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[\?[^\]]*\]/g, ' ')
    .replace(/\*|_|`|#|>|\||\[|\]|\(|\)/g, ' ')
    .match(/[a-z0-9']+/g)
    ?.filter((w) => w.length > 2 && !STOP.has(w)) || [];
}

function fmt(sec) {
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(s)}`;
}

// ------------------------------------------------------------------ main

const args = parseArgs(process.argv.slice(2));
const srtPath = args.srt || args._[0];
const mdPath = args.md || args.markdown || args._[1];
if (!srtPath || !mdPath) {
  console.error('usage: node tools/align.js --srt <file.srt> --md <file.md> [--write]');
  process.exit(1);
}

const MIN_WORDS = Number(args['min-words'] || 6);
const THRESHOLD = Number(args.threshold || 0.18);
const LOOKAHEAD = Number(args.lookahead || 260);

const cues = parseCues(fs.readFileSync(srtPath, 'utf8'));
const cueTokens = cues.map((c) => tokens(c.text));
const raw = fs.readFileSync(mdPath, 'utf8');

// Preserve blank-line separators exactly so the file round-trips.
const parts = raw.split(/(\n[ \t]*(?:\n[ \t]*)*\n)/);
const blocks = [];
for (let i = 0; i < parts.length; i += 2) {
  if (parts[i] === '' && !parts[i + 1]) continue;
  blocks.push({ body: parts[i].replace(/^<!--t:[0-9.]+-->\n?/, ''), sep: parts[i + 1] || '' });
}

// Everything before --start-after is front matter, not speech.
let startIdx = 0;
if (typeof args['start-after'] === 'string') {
  const found = blocks.findIndex((b) => b.body.trim().startsWith(args['start-after']));
  if (found === -1) { console.error(`--start-after not found: ${args['start-after']}`); process.exit(1); }
  startIdx = found + 1;
}

function alignable(body) {
  const t = body.trim();
  if (!t) return false;
  if (/^#{1,6}\s/.test(t)) return false;                 // headings
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return false;    // rules
  if (t.split('\n').every((l) => l.trim().startsWith('|'))) return false; // tables
  return tokens(t).length >= MIN_WORDS;
}

let cursor = 0;
let matched = 0, skipped = 0;
const report = [];

for (let i = startIdx; i < blocks.length; i++) {
  const b = blocks[i];
  if (!alignable(b.body)) continue;

  const want = tokens(b.body);
  const wantSet = new Set(want);
  let best = { score: 0, idx: -1, len: 1 };

  const limit = Math.min(cues.length, cursor + LOOKAHEAD);
  for (let start = cursor; start < limit; start++) {
    // Grow a window of cues until it holds about as many words as the block.
    const seen = new Set();
    let hits = 0, words = 0, len = 0;
    for (let j = start; j < cues.length && words < want.length * 1.3 && len < 14; j++, len++) {
      for (const w of cueTokens[j]) {
        words++;
        if (wantSet.has(w) && !seen.has(w)) { seen.add(w); hits++; }
      }
    }
    const score = hits / wantSet.size;
    // Nudge toward earlier candidates so a later near-tie doesn't skip ahead.
    if (score > best.score + 0.0001) best = { score, idx: start, len };
  }

  if (best.idx >= 0 && best.score >= THRESHOLD) {
    b.t = Math.round(cues[best.idx].t * 100) / 100;
    cursor = best.idx + Math.max(1, Math.floor(best.len * 0.7));
    matched++;
    report.push(`  ${fmt(b.t).padStart(8)}  ${(best.score * 100).toFixed(0).padStart(3)}%  ${b.body.replace(/\n/g, ' ').slice(0, 68)}`);
  } else {
    skipped++;
    report.push(`  ${'—'.padStart(8)}  ${(best.score * 100).toFixed(0).padStart(3)}%  ${b.body.replace(/\n/g, ' ').slice(0, 68)}`);
  }
}

const out = blocks.map((b) => (b.t != null ? `<!--t:${b.t}-->\n` : '') + b.body + b.sep).join('');

console.log(report.join('\n'));
console.log(`\n${matched} aligned, ${skipped} below threshold (${cues.length} cues, ${fmt(cues[cues.length - 1].t)} long)`);

if (args.write) {
  fs.writeFileSync(mdPath, out, 'utf8');
  console.log(`\nwrote ${path.relative(process.cwd(), mdPath)}`);
} else {
  console.log('\ndry run — pass --write to apply');
}
