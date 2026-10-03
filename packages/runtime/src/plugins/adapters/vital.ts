import type { PluginAdapter } from "../adapter.js";

// Names: Vital is open source and gives hosts each parameter's display name ("Filter 1 Cutoff", "Envelope 1 Attack",
// "LFO 1 Frequency", "Modulation 1 Amount"); oscillators read "Oscillator 1 …" or "Osc 1 …", and the patterns take both.
// Folders: Vital's defaults (Music/Vital on a Mac, Documents/Vital on Windows); its settings can move them.
export const vital: PluginAdapter = {
  id: "vital", name: "Vital", vendor: "Vital Audio", kind: "instrument",
  match: /^Vital(ium)?\b/i,
  overview: "Matt Tytel's free wavetable synth. Three wavetable oscillators and a sampler, each sent to Filter 1, Filter 2, both, the effects, or straight out; each oscillator has a spectral morph and a distortion (warp) stage. Then the effects (Chorus, Compressor, Delay, Distortion, EQ, Filter, Flanger, Phaser, Reverb), in the order set in the Effects tab. Six envelopes (Env 1 is the amp), eight LFOs, four random sources and four macros modulate anything by drag and drop. Hundreds of parameters, so Live turns only the configured ones.",
  sections: [
    { name: "Oscillators and sampler", about: "Osc 1–3 have the same controls. The table, the spectral morph mode and the distortion mode are picked in the window.",
      parameters: [
        { role: "level and pan", names: /^Osc(illator)? ?[1-3] (Level|Pan)$/i, about: "Output level and pan." },
        { role: "pitch", names: /^Osc(illator)? ?[1-3] (Transpose|Tune)$/i, about: "Transpose in semitones, Tune in cents." },
        { role: "wave frame", names: /^Osc(illator)? ?[1-3] (Wave ?)?Frame$/i, about: "Position in the table, 0–256: the main timbre move." },
        { role: "unison", names: /^Osc(illator)? ?[1-3] (Unison (Voices|Detune)|Detune (Power|Range)|Stereo Spread|Stack Style)$/i, about: "Voices 1–16 and their detune; Stereo Spread widens them; Stack Style stacks octaves or chords instead." },
        { role: "spectral morph", names: /^Osc(illator)? ?[1-3] (Spectral|Frequency) Morph( Amount| Spread)?$/i, about: "Amount of the morph (Vocode, Formant Scale, Harmonic Stretch, Smear, Low and High Pass, Phase Disperse, Shepard Tone, Skew…)." },
        { role: "distortion", names: /^Osc(illator)? ?[1-3] Distortion (Amount|Spread|Phase)$/i, about: "Amount of the oscillator's warp (Sync, Formant, Quantize, Bend, Squeeze, Pulse Width, FM or RM from another oscillator or the sampler)." },
        { role: "phase", names: /^Osc(illator)? ?[1-3] (Phase|Phase Randomi[sz]ation|Random Phase)$/i, about: "Start phase and its randomness: less random gives tighter, repeatable attacks." },
        { role: "sampler", names: /^Sampler? (Level|Pan|Transpose|Tune)$/i, about: "The sampler's level, pan and pitch (noise and one-shots go here)." },
      ] },
    { name: "Filters", about: "Filter 1, Filter 2 and the effects' filter. Model (Analog, Dirty, Ladder, Digital, Diode, Formant, Comb, Phaser) and style are picked in the window.",
      parameters: [
        { role: "cutoff", names: /^(FX )?Filter ?([12]|FX)? Cutoff$/i, about: "Cutoff frequency." },
        { role: "resonance", names: /^(FX )?Filter ?([12]|FX)? Resonance$/i, about: "0–100%." },
        { role: "drive", names: /^(FX )?Filter ?([12]|FX)? Drive$/i, about: "Drive into the filter, dB." },
        { role: "blend", names: /^(FX )?Filter ?([12]|FX)? (Pass )?Blend$/i, about: "Morphs the response, low-pass through band-pass to high-pass, on most models." },
        { role: "mix and keytrack", names: /^(FX )?Filter ?([12]|FX)? (Mix|Key ?Track)$/i, about: "Mix: dry against filtered. Key Track: how far cutoff follows the note." },
        { role: "formant", names: /^(FX )?Filter ?([12]|FX)? Formant /i, about: "The Formant model's vowel (X, Y), transpose and resonance." },
      ] },
    { name: "Modulation", about: "A source moves only what it's connected to. Each connection's amount is a parameter; what it links isn't.",
      parameters: [
        { role: "amp envelope", names: /^Env(elope)? ?1 (Delay|Attack|Hold|Decay|Sustain|Release)$/i, about: "Env 1, the amp: times in seconds, Sustain 0–100%." },
        { role: "mod envelopes", names: /^Env(elope)? ?[2-6] (Delay|Attack|Hold|Decay|Sustain|Release)$/i, about: "Env 2–6, same stages." },
        { role: "envelope curves", names: /^Env(elope)? ?[1-6] (Attack|Decay|Release) Power$/i, about: "Each stage's curve: snappier or softer." },
        { role: "lfo", names: /^LFO ?[1-8] (Frequency|Tempo|Sync( Type)?|Phase|Fade( In)?( Time)?|Delay( Time)?|Smooth( Time)?)$/i, about: "Frequency in Hz when free, Tempo when synced (the sync mode is a parameter too); Fade and Delay ease it in." },
        { role: "macro", names: /^Macro( Control)? ?[1-4]$/i, about: "0–100%: whatever the preset connected." },
        { role: "connection amount", names: /^Modulation ?\d+ (Amount|Power|Bipolar|Stereo|Bypass)$/i, about: "Connection N: amount (-100% to 100%), curve, bipolar, stereo, bypass. Its source and destination show in the window's matrix." },
      ] },
    { name: "Effects and global", about: "An effect works only while it's on.",
      parameters: [
        { role: "effect on", names: /^(Chorus|Compressor|Delay|Distortion|EQ|Filter FX|FX Filter|Flanger|Phaser|Reverb) (Switch|On|Enabled?)$/i, about: "Turns that effect on or off." },
        { role: "effect mix", names: /^(Chorus|Compressor|Delay|Distortion|Flanger|Phaser|Reverb) (Mix|Dry ?Wet)$/i, about: "Dry/wet, 0–100%." },
        { role: "distortion", names: /^Distortion (Drive|Type)$/i, about: "Drive (dB) and type: Soft Clip, Hard Clip, Linear Fold, Sine Fold, Bit Crush, Down Sample." },
        { role: "compressor", names: /^Compressor (Attack|Release|(Low|Mid|Band|High) )/i, about: "Three-band upward and downward compression, OTT-style: per-band gains, thresholds, ratios; attack, release." },
        { role: "delay", names: /^Delay (Feedback|Frequency|Tempo|Sync|Style|Filter)/i, about: "Feedback %, time (Hz, or Tempo when synced), Style (mono, stereo, ping-pong), a filter on the repeats." },
        { role: "reverb", names: /^Reverb (Decay|Size|Delay|Pre|Low|High|Chorus)/i, about: "Decay time, size, pre-delay, the tail's filtering and chorus." },
        { role: "volume and voices", names: /^(Volume|Polyphony|Portamento (Time|Slope)|Legato)$/i, about: "Output volume (dB); Polyphony 1–32 (1 is mono); glide time and curve; Legato glides only overlapping notes." },
      ] },
  ],
  recipes: [
    { name: "Reese bass", how: "Osc 1 and 2 on the default saw, Osc 2 Tune +10 to +15 cents (or one oscillator, Unison Voices 2–3, low detune). Both to Filter 1: Analog low-pass, 24 dB style, cutoff 300–800 Hz, Drive 6–10 dB, LFO 1 at 1–2 bars moving cutoff a little. Polyphony 1, Portamento 50 ms. Distortion soft clip a few dB; Chorus 20%." },
    { name: "Supersaw", how: "Osc 1 saw, Unison Voices 8–12, detune a third of the way up, Stereo Spread full; Osc 2 the same, Transpose +12, quieter. Env 1 Attack 10 ms, Release 0.4 s. Chorus 30%, Reverb 20%." },
    { name: "Pluck", how: "Osc 1 saw or square. Filter 1 low-pass near 200 Hz, Resonance 20%. Env 2 to Filter 1 cutoff, large amount: Attack 0, Decay 0.2–0.4 s, Sustain 0. Env 1 Decay 0.4 s, Sustain 0, Release 0.2 s. Delay ping-pong 1/8 dotted, 20%." },
    { name: "Neuro growl", how: "Osc 1 on a vocal or formant table, Wave Frame on LFO 1 (synced 1/8, a shaped curve). Osc 1 distortion FM from Osc 2 (a sine an octave down) at 30–60%. Filter 1 Formant model, X on LFO 2. Effects: Distortion (sine fold), Compressor at 100%, EQ low cut at 120 Hz; the sub on its own oscillator or track." },
    { name: "Spectral pad", how: "Osc 1 and 2 on soft tables, Spectral Morph (Smear or Harmonic Stretch) on a slow LFO, Unison 6, Stereo Spread full. Env 1 Attack 0.6–1 s, Release 2–3 s. Low-pass near 3 kHz. Chorus 40%, Reverb 30% with a 4–6 s decay." },
    { name: "Wobble", how: "LFO 1 Tempo 1/4–1/8 (or a triplet) on Filter 1 cutoff over most of its range, a little on Wave Frame. Analog or Dirty low-pass, Drive 10 dB, Resonance 25%. Polyphony 1, Legato on. Distortion a few dB." },
  ],
  beyond: "Not host parameters: which source moves what (drag a source's handle onto a knob in Vital's window; its amount then shows as a Modulation N parameter), wavetables (the pencil above an oscillator opens the editor; a WAV dropped on it loads, Serum-style tables included), LFO shapes (drawn in each LFO), the effects' order (Effects tab). Presets are JSON (.vital): author, comments, preset_style, macro1–macro4 (the macros' names), synth_version, and settings, which holds every parameter by its internal id (osc_1_level, osc_1_wave_frame, filter_1_cutoff, env_1_attack…) in Vital's own units, not 0–1 (cutoff is a note number: 60 is about 262 Hz). settings.modulations lists the connections as {source, destination} (lfo_1 → filter_1_cutoff), each amount in modulation_N_amount; settings.wavetables, lfos and sample hold the rest. For a routing or a table no parameter reaches, Kumi can edit a saved .vital (the producer saves the sound first) and write it under a new name into the user Presets folder, for the producer to load from Vital's browser.",
  folders: {
    presets: { mac: "~/Music/Vital/User/Presets", windows: "~/Documents/Vital/User/Presets" },
    wavetables: { mac: "~/Music/Vital/User/Wavetables", windows: "~/Documents/Vital/User/Wavetables" },
  },
  wavetable: { frame: 2048, maxFrames: 256, format: "clm" },
};
