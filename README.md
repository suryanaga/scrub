# scrub

A local transcript editor with the audio attached. Click anywhere in the transcript to hear
that moment; double-click to fix the wording. Edits save straight back to the file on disk.

No build step, no dependencies, no hosting. It's a ~200-line Node server that reads your
files and serves a single page to `localhost`. Nothing leaves the machine.

## Run it

```bash
node server.js --audio recording.m4a --transcript transcript.md
```

It opens your browser automatically. Or put a `scrub.json` next to your work:

```json
{
  "audio": "~/Documents/Zoom/interview/audio.m4a",
  "transcript": "docs/interview.md",
  "port": 4173
}
```

...and run `node /path/to/scrub/server.js` from that directory. Paths in the config resolve
relative to the config file; `~` works.

Flags: `--port <n>`, `--no-open`, `--config <file>`.

## Using it

| | |
|---|---|
| **Click** a paragraph | play from that point — the position within the paragraph is interpolated, so clicking near the end starts near the end |
| **Double-click** | edit that block as raw source; `esc` cancels, `⌘⏎` or clicking away saves |
| **Space** | play / pause |
| **← →** | back / forward 5s |
| **/** | search; `enter` for next, `shift+enter` for previous |
| **⌘S** | force a save now |

Saves are debounced (~0.7s after you stop typing). The first write copies the original to
`<file>.orig`. If the file changes underneath you in another editor, the save is refused and
you get the choice of reloading or overwriting.

## Transcript formats

**`.srt` / `.vtt`** work as-is — every cue already has a timestamp, so clicking is exact.
Edits are written back as valid subtitles with the cues renumbered. Opening and saving without
changing anything is a byte-for-byte no-op, but note that a file with unusual formatting
(CRLF endings, gaps in the cue numbering) comes back normalised.

**`.md`** is rendered as markdown, with timings read from `<!--t:SECONDS-->` comments above
each paragraph:

```markdown
<!--t:130.22-->
We also have poetry and music, which are expressions of our value for the arts.
```

Blocks without a comment still render and edit — they just aren't clickable for audio. The
comments are invisible in any rendered markdown, and are hidden while editing so you can't
delete one by accident.

## Giving a cleaned-up transcript its timecodes back

Once you've rewritten a raw transcript into readable prose, it no longer matches the subtitle
text word for word — but the *order* is unchanged. `tools/align.js` walks both documents
forward together and, for each paragraph, finds the window of cues it overlaps most:

```bash
node tools/align.js --srt audio.srt --md transcript.md --start-after "## The transcript"
```

That's a dry run — it prints each paragraph with its match score so you can see where it's
guessing. Add `--write` to insert the comments.

`--start-after "<line>"` skips front matter that was never spoken. Other knobs:
`--min-words` (default 6), `--threshold` (0.18), `--lookahead` (260 cues).

Scores above ~60% are solid. A run of low scores usually means the two documents have drifted
apart — check whether you reordered something.

## Why a server rather than just opening the HTML

Two things a `file://` page can't do: write back to the file you opened, and serve byte-range
requests, without which the browser can't seek within a long audio file. Both are a few lines
on a local server, and neither needs anything installed.
