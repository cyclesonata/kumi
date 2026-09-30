# Kumi's benchmark: recreate a section by ear

The prompt, exactly as a producer typed it, in the real app (`npm run kumi`, full screen, driven through
a PTY by `.pi/kumi-evidence/tui/match-session.py`) on real Live 12.4 (bridge 1.0.52), in the disposable
"Kumi Acceptance" Set at 120 BPM, with an empty MIDI track "Benchmark" selected:

> https://www.youtube.com/watch?v=TnsvhczQtGE Listen to 0:05 - 0:25 of this track. Recreate the sound and
> the sequence on this track using native ableton devices.

The reference is Autechre, "VI Scose Poise", 0:05–0:25: 20 s, mono, centred in the low mids (250–500 Hz),
saw-like with a wavering pitch around C3, swelling from −33 to −17 LUFS, 3.8 onsets a second (repeated C3
pulses, then denser unpitched hits, then two long notes).

**Score.** `.pi/kumi-evidence/benchmark/score.mjs` renders what's on the Benchmark track (its Arrangement
from its first clip, or its first Session clip) for as long as the reference and scores it with Kumi's
closeness as a section (0–100: balance, tilt, brightness, movement, envelope, pitch, density, width, and,
from run 1's harness on, rhythm and contour). Every run is scored with the current scorer, so rows compare;
the model's own view of its score during the run is noted too. Each run's render is kept in
`.pi/kumi-evidence/benchmark/renders/`.

**Held out** (never tuned on; checked when the benchmark improves, to catch changes that only help it):
1. `keys-chord-ref.wav`: a 2.3 s Operator chord (a single sound).
2. A two-bar riff rendered from a patch built for it (a sequence with its own rhythm).

**Clean runs.** From run 2 on, each run starts with empty techniques, playbook and memory files (`KUMI_TECHNIQUES_FILE`,
`KUMI_PLAYBOOK_FILE`, `KUMI_MEMORY_FILE`, `KUMI_PROJECTS_DIR` pointed at a fresh folder), so a run can't lean on what an
earlier run on this reference saved. Run 1 didn't: it read two techniques saved from earlier work on this track.

**No special-casing.** No presets, notes or anything particular to this reference: every change is a
general improvement to the harness.

## Runs

| Run | Commit | Model | Score | Features (lowest) | Time | Tokens | What changed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | a27bcfa | Claude Sonnet 5.5 | **40** (the model's own: 26 → 72, before timing counted) | rhythm 0, movement 10, contour 29, density 33, balance 39 | 25:32 | 5.29M in (4.75M cached), 40.4k out | Baseline. Four candidates (Collision, Analog, Operator, Drift, Wavetable), the winner an Analog with a saturator, noise and air, a dense phrase an octave up, as a Session clip on a new track (not the selected one). It set the Set's tempo to 185 BPM (the reference's estimate). Its sequence was a guess: nothing lines up with the reference's onsets, and it doesn't swell. |
| 1 | 57a3ac6 | Claude Sonnet 5.5 | **67** (the model's own: 55 → 70) | rhythm 24, movement 47, balance 53, envelope 54 | 28:52 | 8.35M in (7.68M cached), 47.7k out | Transcription, rhythm and contour in the score, the selection in the observation, the wrap-up mutes. It transcribed the reference at 185 BPM and wrote its 153 notes (so density 87, contour 84), then tuned five candidates to a Drift saw → Saturator → Utility → EQ Eight (a 5 dB cut at 1.4 kHz). Not clean: it read two techniques saved from earlier work on this track. Still on a new track, not the selected one. Rhythm stayed low: the render's hits lag the reference's by 60 ms at first and 130 ms a second in, since the transcription rounded every start to a 16th at a guessed tempo and the reference isn't on a grid. Most of its 30 auditions were one candidate and one knob at a time (about 40 s each). |
