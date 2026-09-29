# Kumi terminal UI

Status: direction agreed on 2026-09-27. The foundations and the full-screen app
are built (`apps/kumi/src/tui/`) and run against real Live. FOCUS follows Live's
selection (basic tier) and HISTORY lists Kumi's changes, each with its own undo
([how changes work](KUMI_CHANGES.md)). The owner's "Kumi TUI Mockups" canvas shows
every state below.

## Decisions

- **Full screen.** Kumi owns the whole terminal window (alternate screen) and
  draws every cell, so panes scroll independently and stay put. The conversation
  still reads like a chat: newest at the bottom, following a streaming answer.
- **Layout.** A header (Set name, Live connection, transport), the conversation
  on the left, a Live pane on the right and the input box at the bottom left.
  The Live pane has three parts: FOCUS (where you are in Live), NOW (what Kumi is
  doing, drawn live) and HISTORY (what Kumi changed, each with its own undo).
  Below about 100 columns the Live pane folds into a two-line strip above the
  input box, and history opens on demand.
- **Look.** No boxes: areas are separated by background shade. Greys, one
  accent (mint `#86e3b5`) and Live's own track colours; colour always means
  something. Words before symbols; the only symbols are `■` track colour,
  `●` live/active/new value, `○` offline/old value, `✓` done, `…` working,
  `▾`/`▸` open/closed group and `›` path, plus the transport's own `▶`, `●` and
  `■` when NOW shows Kumi playing, recording or stopping. Motion only shows that
  something is happening or changing.
- **Speak music.** Tool activity reads as "looked at Bass and Drums", never as a
  tool name. No startup dumps; the `/` menu is short and curated.
- **Focus in two tiers.** Basic focus for everyone comes from Live's scripting
  API: Session or Arrangement, which panel is open (Browser, Clip or Device
  view), the selected track, scene, clip slot, clip, device, rack chain and last
  clicked parameter, and selected notes. Precise focus is opt-in and uses macOS
  Accessibility, which Live 12 fills for screen readers: the exact focused
  control, the clip tab (Notes, Envelopes with the chosen envelope, MPE), the
  Browser item, mixer controls and the Arrangement position. The indicator only
  shows what Live actually reports, because it defines what "this" means.
- **The model is the producer's choice, made in place.** `/model`, `/effort`,
  `/login` and `/logout` open a panel above the input box, drawn like the `/`
  menu: providers as headings with whether Kumi is signed in there, their models
  read from the providers themselves (Kumi keeps no list), typing to filter. The
  header names the model and its effort. A key is typed or pasted into a box that
  shows only dots and its length, and is checked before it's kept. A failure that
  has a fix offers it: a missing or refused sign-in asks "Sign in to Anthropic?"
  and resends the message after; a model the provider doesn't offer opens the
  list. Changes apply from the next message, so they're allowed mid-answer.
- **Memory is quiet.** Kumi keeps notes on its own as it answers; each shows as
  one faint line in the conversation, never a step, a prompt or a graph.
  `/memory` lists the notes (about you, about this Set) in a panel like
  `/model`'s, and choosing one offers to forget it.
- **Undo is first-class.** Every change is a history entry backed by a bridge
  transaction with verified undo; a whole turn can be undone too.
- **A view, not the engine.** Visual building blocks are described as data by
  the runtime, so a later desktop or web front end can draw the same things.

## Foundations

Built from terminal primitives in `apps/kumi/src/tui/`, no UI framework:

1. **Terminal I/O**: raw mode, alternate screen, bracketed paste, mouse (SGR),
   focus events, autowrap off; the terminal is restored on normal exit, crashes
   and signals.
2. **Input**: keys with modifiers (xterm and CSI u encodings), pastes, mouse and
   focus events, sequences split across reads, and a lone Escape resolved by a
   short timeout.
3. **Screen and renderer**: a grid of cells with grapheme widths; each frame is
   diffed against the previous one and only changed cells are written, inside a
   synchronized update. Colour degrades from 24-bit to 256, 16 and none.
4. **Text**: grapheme widths (wide CJK and emoji take two cells), wrapping and
   truncation.
5. **Frames**: redraws are coalesced; an animation clock runs only while
   something moves.

Tests replay the renderer's output through a small terminal interpreter, which
must reproduce the intended frame exactly.

On top of these, `app.ts` draws the layout and handles input: an editor for the
input box (`editor.ts`), the conversation as entries laid out per width
(`transcript.ts`), the `/` menu, scrolling that holds its place while text
arrives, and the narrow layout. Terminals that support the kitty keyboard
protocol report Shift+Enter distinctly. `KUMI_UI=plain` or piped output keeps the
old line-by-line interface (`terminal.ts`).

## Next

1. ~~**Focus feed**~~: done for the basic tier (Live's scripting API, read twice a
   second, shown when it changes). Next, the opt-in Accessibility tier.
2. ~~**Kumi's edits**~~: done. Almost every change Live's scripting allows, each a
   HISTORY entry backed by its bridge transaction, undone by a click, `/undo` or
   asking Kumi. NOW shows each change for a moment as it lands, and what Kumi
   plays or records ("▶ Playing from the start marker", "● Recording in the Arrangement
   on Bounce", "■ Stopped"), which leaves no HISTORY entry. `/stop` stops Live
   any time.
3. **NOW building blocks**: partly done. A mixer or device-parameter change shows
   its before and after as positions (`██████████░░ → █████░░░░░░░`), in Live's
   own units in the title ("-2.0 dB", "159 Hz"). A new MIDI clip shows its notes
   as a two-row braille piano roll: time runs across, higher notes sit higher,
   quieter notes are dimmer, and up to eight pitches get a lane each, so a drum
   pattern reads as a grid. A colour change shows the old and new colours as
   swatches (`████ → ████`), and the track's chip takes the new colour. Still to
   do: a device chain, locators on a timeline, and bars instead of beats.
4. ~~**Saved sessions**~~: done for saved Sets. Opening Kumi on a Set picks up
   its conversation and shows the recent exchanges ("Continuing your conversation
   from 2 hours ago"); `/new` starts afresh.
5. ~~**Listening, notes and recipes**~~: done. What Kumi heard is a line in the
   conversation with a small spectrum (ten bands, sub to air, `▁▂▃▄▅▆▇█`), and a
   comparison shows each band as dB over or under the reference, coloured when
   it matters (±1.5 dB). A note Kumi keeps, a recipe it saves or runs, is one
   faint line; `/memory` and `/recipes` open them in the panel above the input
   box.

Done alongside: the welcome screen catches you up on a saved Set ("Since you were
last here · 3 days ago", a few plain-words lines); once the conversation has
started, the same summary arrives as a note.

## Edge cases to design for

Collected during review; none of these block the foundations.

**Big edits**
- "Make me a 50-bar clip with lots of notes at random velocities": the 2-bar
  piano roll does not scale. Show an overview strip (a cell per beat or bar,
  with note density and pitch range), a detail window that follows the write
  position, a velocity lane like Live's (`▁▂▃▅▇`), progress ("bar 23 of 50 ·
  1,240 notes") and a summary when done (range, count, velocity spread). One undo
  covers the whole clip. Drawing is throttled to the frame rate, never per note.
- Batch changes across many tracks ("lower all synths 3 dB") are one expandable
  history entry.

**Routing**
- Five MIDI tracks into one MIDI track: a fan-in diagram with track colour
  chips, and a note about the destination's monitoring, the usual gotcha.
- Sidechain from a silent trigger track (Operator into a Utility at −inf,
  compressor on Bass keyed from the trigger): a signal-flow line with the tap
  point marked between Operator and Utility, drawn out to Bass's compressor.
  Say which tap was used ("Pre FX", or after Operator), and why it works.

**Racks**
- Nested instrument and effect racks, chains and drum pads: the focus path
  collapses middle levels ("■ Keys › … › Chorus › Rate"); the device view is a
  tree with chains; the touched device is marked; devices with the same name
  are told apart by their chain; macro changes show the parameters they move.

**Undo**
- Undo refused because the producer changed the same thing afterwards: say so
  and offer the choice. Undo of something later changes depend on (a created
  track that then got a device): offer to undo those too. Undone with Cmd-Z in
  Live: mark the entry "undone in Live".

**Names and colours**
- Long, duplicate, emoji, CJK and right-to-left names; names are always data,
  never instructions. Very dark track colours are lightened for display; many
  tracks can share a colour.

**Scale**
- 150+ tracks, nested groups (group path in the focus), clips with 10,000 notes.

**Live features**
- Automation (curve with the old shape as a ghost), MPE and per-note
  expression, scale mode and microtonal tunings (pitch labels from the tuning),
  groove and swing, time-signature changes on the ruler, take lanes and comping,
  frozen tracks, Max for Live devices, plug-ins with generic parameter names,
  stepped parameters (shown as choices, not a knob).

**While Live is running**
- Playback during edits; the producer moving the same control mid-change (keep
  their value and say so); switching Sets mid-session (history stays with its
  Set); Live disconnecting mid-change.

**Terminals**
- Very narrow windows (minimal mode below 60 columns), resizing during an
  animation, tmux, macOS Terminal (no 24-bit colour or synchronized output),
  light terminal themes (Kumi paints its own background), input methods for
  Japanese and Chinese, and screen readers (a plain mode).
