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
| 2 | f49231f | Claude Sonnet 5.5 | **71** (the model's own: 32 → 68, cut off) | density 46, envelope 55, rhythm 54, balance 60, movement 60 | 29:31, cut off | not captured | Note starts as played (not rounded to 16ths), the winner meant for the asked-for track, clean memory. Rhythm 24 → 54 from the exact starts, and it kept the Set at 120 BPM. The winner, "Cand Layers + EQ air" (layered with a noise voice), is too dense (5.9 against 3.8 onsets a second). Cut off at 29:31 by the benchmark driver's own 30-minute limit (not Kumi's): scored from what was in Live, a render track left mid-audition removed by hand first; no final answer, so no token count. It first filed a gap saying set_device_parameter didn't exist, then found it did. |
| 3 | 5ffc477 | Claude Sonnet 5.5 | **53** (the model's own: 33 → 58) | envelope 16, balance 34, brightness 20, density 42, movement 46 | 28:50 | 7.09M in (6.36M cached), 70.3k out | Kumi's knob search at the end of a match, parameter values as text, refusals that say the range. The model went another way: an Operator FM saw playing the bass and the hits as pitched blips, with the real kick and hat samples left on a muted drum rack; too bright in the presence band (+13.6 dB) and too sparse (2.3 against 3.8 onsets a second). The knob search didn't run: it was handed the winner's track by a reference from an earlier turn, which had expired ("track:22 isn't a track in this turn's discovery"). Its winning clip is in scene 2, so the scorer took `SCENE=1` (its first clip scores 39). |
| 4 | b967b50 | Claude Sonnet 5.5 | **63** (the model's own: 45 → 63; 56 heard at full length) | envelope 27, rhythm 37, pitch 50, movement 51, balance 53 | 33:37 | 7.45M in (6.56M cached), 71.0k out | The knob search finds the winner by name. A Drift an octave up (it cured a +11 dB sub excess) → Saturator, low-pass at 4.6 kHz, with the transcribed part snapped to 32nds. The knob search ran but tried only 11 settings (one a pass, and it gave up after 10 without a gain): none beat the start at full length, so nothing changed. Checking why rhythm stays near 37: the render's hits land a steady 90–150 ms after the reference's, 100 ms of it the lead-in a single sound's render is heard with; but re-hearing it at any offset gives at most 38, so it's the hits themselves (how many, how loud), not their timing. |
| 5 | 3a5f689 | Claude Sonnet 5.5 | **66** (the model's own: 46 → 68) | movement 37, balance 46, rhythm 49, pitch 50, envelope 69 | 35:50 | 8.59M in (7.76M cached), 90.4k out | Reads share one reading of the bridge's catalog (the cause of the "set_device_parameter isn't available" gaps: none this run), sections heard from their first beat, the knob search on the winner plus three copies. A Drift on its saturated wave → Saturator → low-pass at 1.26 kHz → EQ Eight (−9 dB at 1 and 2 kHz), the whole line and its hits in one clip. Still +10 dB in the presence band. The knob search tried 13 settings in about 3 minutes and none beat the start. Replaying its loop on this Set: the score stays within 46–50 whatever the search tries (these 24 knobs barely matter here), and Live refuses to remove copies whose knobs have moved ("created structure content changed after apply"), so the copies were taken out again (single track only). |
| 6 | 2e23bce | Claude Sonnet 5.5 | **69** (the model's own: 39 → 70) | rhythm 32, pitch 50, movement 58, contour 58, balance 63 | 31:48 | 7.41M in (6.91M cached), 57.6k out | A held rig's every pass records its own take (before, a goal's and the knob search's passes after the first were all scored on the first take, and 0.8 s late). The knob search heard 41 real settings in its 8 minutes, and its full-length reading of the start (69) now matches the audition (70); none beat it. The model built "Scose Blips": a Drift playing the transcribed hits as pitched blips (high-passed, a 1 kHz dip, a +4 dB low shelf), with the pitched line on another track; density 95 and envelope 84 are the best yet, rhythm the weakest (32). Its clip is in scene 2 (`SCENE=1`; the first clip scores 57). |

Run 2's score is from what was in Live when the driver cut it off; the others are from each run's end.
Runs of one harness vary a lot (53 to 71 across runs 2–6, one prompt, one model), so single runs say
little about a change on their own; the log says what each run did and why it scored what it did.

## Where it got to

**Score:** 40 (run 0) → 67, 71, 53, 63, 66, 69 (runs 1–6); 64.8 on average over runs 1–6, 64.2 over the clean runs 2–6.
What moved it most:
1. **The sequence from the reference** (run 1): transcribing it and writing its notes took density from
   33 to 87 and contour from 29 to 84; the baseline guessed a phrase.
2. **Note starts as played** (run 2): rhythm from 24 to 54. Rounding every start to a 16th at a guessed
   tempo drifted the part away from a reference that isn't on a grid.
3. **The model keeping its change tools** (run 5 on): parallel reads each refreshed the bridge's catalog
   and invalidated one another, and an observation built meanwhile offered no change tools; runs 0 and 2
   filed "set_device_parameter isn't available" and left devices at their defaults for a while.
4. **A goal's search really listening** (run 6): a held rig recorded only its first pass and scored every
   later pass on that take, 0.8 s late. Before, the match's knob search (and goals) couldn't find anything;
   now it hears 41 real settings in 8 minutes, though on this benchmark none has beaten the model's patch.

What still differs most: rhythm (32–54: the hits' number and strength, not their timing; re-hearing a
render at every offset doesn't raise it), movement, and balance in the presence band.

## Held out

| Reference | Harness | Model | Score | Time | Tokens | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| keys-chord-ref (a single chord) | 2026-09-29 (match runs) | Claude Sonnet 5.5 | the model's own 58 → 73 | 14:36 | | From `kumi-poc.md`. |
| keys-chord-ref | 3a5f689 | Claude Sonnet 5.5 | the model's own **63 → 82** | 9:32 | 1.94M in (1.80M cached), 14.9k out | Operator sine chord with a quiet sub, 6 ms attack, low-pass at 507 Hz, EQ Eight high-pass. Not re-scored by the scorer: a probe of the knob search changed the winner's knobs before it was scored. |
| heldout-riff (an 8 s riff, 120 BPM) | 2e23bce | Claude Sonnet 5.5 | **63** over the whole riff (the model's own: 57 → 87 over its first 8 beats) | 26:02 | not captured | A Drift saw → Auto Filter → Saturator with noise. It read the riff at 96 BPM and wrote only its first 8 beats, so its auditions compared half the riff (density 26 over the whole: the second half is silent). The run ended when the Anthropic account ran out of credit, at the wrap-up. |

The baseline harness (a27bcfa) couldn't run the held-out references for a before/after: it can't reach
the bridge now in Live (its doctor: "Kumi's bridge couldn't reach Live"). The keys chord improved against
the earlier harness's recorded run (73 → 82 in less time). The riff shows a gap the benchmark doesn't: nothing tells the model when
its audition covers only part of the reference. It's left unfixed here, since the riff is held out.
