import type { PluginAdapter } from "../adapter.js";

// Names: Serum 1 named its parameters tersely ("A WTPos", "A UniDet", "Fil Cutoff", "Env1 Atk", "Dly Wet"). Serum 2's
// own names aren't confirmed here, so each pattern takes those and spelled-out forms ("Osc A WT Pos", "Filter 1 Cutoff").
export const serum2: PluginAdapter = {
  id: "serum2", name: "Serum 2", vendor: "Xfer Records", kind: "instrument",
  match: /\bSerum ?2\b(?!.*\bFX\b)/i,
  overview: "Xfer's wavetable synth. Three main oscillators (A, B, C), each a Wavetable, Multisample, Sample, Granular or Spectral oscillator, plus a Sub and a Noise oscillator. The oscillators feed two filters (in series or parallel) or skip them, then the amp and the FX rack: a main chain and two buses. Envelopes (Env 1 is the amp), LFOs and macros move other knobs through the mod matrix. Hundreds of parameters, so Live turns only the configured ones.",
  sections: [
    { name: "Oscillators A, B, C", about: "The same controls on each, named by its letter. Type, table or sample, and warp mode are picked in the window; these shape what's loaded.",
      parameters: [
        { role: "level", names: /^(Osc ?)?[ABC] ?(Vol(ume)?|Level)$/i, about: "0–100%." },
        { role: "pan", names: /^(Osc ?)?[ABC] ?Pan$/i, about: "Left to right." },
        { role: "pitch", names: /^(Osc ?)?[ABC] ?(Oct(ave)?|Semi|Fine|Coarse( ?Pit(ch)?)?)$/i, about: "Octave ±4, Semi ±12, Fine ±100 cents; Coarse is continuous semitones, for sweeps." },
        { role: "unison voices", names: /^(Osc ?)?[ABC] ?Uni(son)?( ?Voices)?$/i, about: "1–16 voices." },
        { role: "unison detune", names: /^(Osc ?)?[ABC] ?(Uni(son)? ?)?Det(une)?$/i, about: "Spread between voices: a little thickens, a lot is a supersaw smear." },
        { role: "unison blend and width", names: /^(Osc ?)?[ABC] ?(Uni(son)? ?)?(Blend|Width)$/i, about: "Blend: side voices against the center (lower keeps the lows solid). Width: their stereo spread." },
        { role: "wavetable position", names: /^(Osc ?)?[ABC] ?(WT|Wavetable)? ?Pos(ition)?$/i, about: "Which frame plays (1 to the last): the main timbre move, often on an envelope or LFO. For sample types, where in the sample." },
        { role: "warp", names: /^(Osc ?)?[ABC] ?Warp ?\d?$/i, about: "Amount of the warp mode picked in the window (Sync, Bend, PWM, Asym, Mirror, Quantize, FM, AM or RM from another oscillator…)." },
        { role: "phase", names: /^(Osc ?)?[ABC] ?(Rand(om)? ?Phase|Phase|Rand(om)?)$/i, about: "Start phase and its randomness per note; Random at 0 starts every note alike (tight bass)." },
      ] },
    { name: "Sub and Noise", about: "Sub: a plain wave (sine, triangle, saw, square, pulse) set by octave, for weight. Noise: a sample from Serum's noise list (white noise, vinyl, textures, one-shots).",
      parameters: [
        { role: "sub", names: /^Sub ?(Osc)? ?(Vol(ume)?|Level|Shape|Oct(ave)?|Pan)$/i, about: "Level 0–100%, octave against the note, wave, pan." },
        { role: "noise", names: /^Noise ?(Osc)? ?(Vol(ume)?|Level|Pitch|Fine|Pan|Phase|Rand(om)? ?Phase)$/i, about: "Level 0–100%, playback rate (keytracking is a switch in the window), pan, phase." },
      ] },
    { name: "Filters", about: "Two filters, in series or parallel. The type (MG Low 24 and other ladders, combs, formants, flangers, many more) is picked in the window; these knobs work on each.",
      parameters: [
        { role: "cutoff", names: /^(Fil(ter)?|F) ?[12]? ?(Cutoff|Freq(uency)?)$/i, about: "Hz." },
        { role: "resonance", names: /^(Fil(ter)?|F) ?[12]? ?Res(o(nance)?)?$/i, about: "0–100%; high values ring." },
        { role: "drive", names: /^(Fil(ter)?|F) ?[12]? ?Dri?ve?$/i, about: "Saturation into the filter, 0–100%." },
        { role: "var", names: /^(Fil(ter)?|F) ?[12]? ?(Var|Fat|Spread|Morph)$/i, about: "The type's extra knob: Fat on many low-passes, Spread on dual types, Morph on others." },
        { role: "mix", names: /^(Fil(ter)?|F) ?[12]? ?(Mix|Wet)$/i, about: "Dry against filtered; 100% is fully filtered." },
        { role: "level and pan", names: /^(Fil(ter)?|F) ?[12]? ?(Level|Vol(ume)?|Pan)$/i, about: "After the filter." },
      ] },
    { name: "Envelopes, LFOs and macros", about: "Env 1 drives the amp. The other envelopes, the LFOs and the macros move only what the mod matrix routes them to.",
      parameters: [
        { role: "amp envelope", names: /^Env(elope)? ?1 ?(Atk|Attack|Hold|Dec(ay)?|Sus(tain)?|Rel(ease)?)$/i, about: "Attack, Hold, Decay, Release in ms or s; Sustain in dB." },
        { role: "mod envelopes", names: /^Env(elope)? ?[2-9] ?(Atk|Attack|Hold|Dec(ay)?|Sus(tain)?|Rel(ease)?)$/i, about: "Same stages; Env 2 is the usual filter or pitch envelope." },
        { role: "lfo", names: /^LFO ?\d+ ?(Rate|Rise|Delay|Smooth)$/i, about: "Rate in Hz, or a note value when synced (BPM, in its window); Rise and Delay fade it in, Smooth rounds it." },
        { role: "macro", names: /^Macro ?\d+$/i, about: "0–100%. Factory presets route them to the moves that matter: often the best handles." },
      ] },
    { name: "Global and FX", about: "An FX module (Hyper/Dimension, Distortion, Flanger, Phaser, Chorus, Delay, Compressor, Reverb, EQ, Filter and Serum 2's newer ones) works only while it's in the rack and on.",
      parameters: [
        { role: "main volume", names: /^(Master|Main) ?Vol(ume)?$/i, about: "Output level." },
        { role: "glide", names: /^(Porta(mento)?|Glide)( ?(Time|Curve))?$/i, about: "Glide time and curve; mono and legato are switches." },
        { role: "fx mix", names: /\b(Hyp(er)?|Dim(ension)?|Dist(ortion)?|Fl(an)?g(er)?|Ph(a)?s(er)?|Cho(rus)?|D(e)?l(a)?y|C(o)?mp(ressor)?|(Re)?Verb|EQ|FX ?Fil(ter)?)\w* ?(Wet|Mix)$/i, about: "Each module's dry/wet, 0–100%." },
        { role: "distortion drive", names: /\bDist(ortion)? ?(Drv|Drive)$/i, about: "0–100%, into the mode picked in the window (Tube, soft and hard clip, diode, folds, downsample…)." },
        { role: "delay", names: /\bD(e)?l(a)?y ?(Feed(back)?|Tim(e)? ?[LR]?|Time (Left|Right)|BPM[ _]?Sync|Link|Mode)$/i, about: "Feedback %, left and right times (ms, or note values when synced), ping-pong." },
        { role: "reverb", names: /\b(Re)?Verb ?(Size|Decay|Pre ?D(elay)?|Lo ?C(u)?t|Hi ?C(u)?t|Low ?Cut|High ?Cut|Width|Damp)$|^(Decay|Damp)$/i, about: "Size, decay, pre-delay, width, and the tail's low and high cuts." },
        { role: "compressor", names: /\bC(o)?mp(ressor)? ?(Thr(esh(old)?)?|Rat(io)?|Att(ack)?|Rel(ease)?|Gain|M ?Bnd|Multi ?band)$/i, about: "Threshold, ratio, attack, release, gain. Multiband makes it a three-band, OTT-style squash." },
      ] },
  ],
  recipes: [
    { name: "Reese bass", how: "Osc A and B on a saw (Basic Shapes at its saw frame), B Fine +10 to +15 cents, or one oscillator with Unison 2–3, low detune. Sub sine an octave down at 60–70%. MG Low 24 at 400–800 Hz, Drive 20–30%, a slow LFO (1–2 bars) moving cutoff a little. Mono, glide 40–80 ms. Distortion Tube 20–30%." },
    { name: "Supersaw", how: "Osc A saw, Unison 7–9, detune a quarter of the way up, Blend 70–80%; Osc B the same an octave up, quieter. Filter off or low-pass at 8–10 kHz. Env 1 Attack 5–10 ms, Release 300–500 ms. Hyper/Dimension 25–35%, Reverb 15–20%." },
    { name: "Pluck", how: "One bright oscillator. Filter Low 24 at 200–400 Hz, Resonance 10–20%. Env 2 to cutoff, large amount: Attack 0, Decay 150–400 ms, Sustain -inf. Env 1 Decay 300–600 ms, Sustain -inf, Release 150–250 ms. Delay 1/8 dotted at 15–20%, Reverb 15%." },
    { name: "Neuro growl", how: "Osc A on a vocal or formant table, LFO 1 synced 1/8 or 1/16 on WT Pos (40–60% of its travel). Warp FM from B (B a sine an octave down) 30–60%, on the same LFO. A formant or comb filter, Var on a second LFO. Distortion (Diode or Tube) 50–70%, Compressor multiband, EQ cut below 100–150 Hz; the sub from Sub or its own track." },
    { name: "Sub bass", how: "Sub sine alone (or Osc A on a sine) at 70–80%, mono. Env 1 Attack 1–3 ms, Release 30–80 ms. Random phase 0 on any oscillator used; no unison, no stereo FX." },
    { name: "Wobble", how: "LFO 1 synced 1/4, 1/8 or a triplet, to Filter 1 cutoff over most of its range and a little WT Pos. MG Low 24, Drive 30%, Resonance 20%. Mono, legato. Distortion 30–40%." },
    { name: "Evolving pad", how: "Osc A and B on soft tables, Unison 4–6, low detune, a slow LFO (0.1–0.3 Hz) on WT Pos. Env 1 Attack 400–800 ms, Release 1.5–3 s. Low-pass at 2–4 kHz. Chorus 30%, Reverb 30–40%." },
  ],
  beyond: "Not host parameters: an oscillator's type and its table or sample (the menu above its display, the wavetable editor, or a file dropped on the display), warp mode, filter type, the mod matrix (which source moves what, how much, on which curve: the MATRIX page, or a source dragged onto a knob), LFO and envelope shapes, which FX are in the rack and their order (the FX page, drag to reorder), the arpeggiator and clip sequencer. Do these in Serum's window (Kumi can open it) or ask the producer, then come back to the knobs. A wavetable Kumi makes (2048-sample frames, up to 256, with Serum's \"clm \" chunk) loads when the producer drags the file (from Live's browser or its folder) onto an oscillator's display.",
  wavetable: { frame: 2048, maxFrames: 256, format: "clm" },
};
