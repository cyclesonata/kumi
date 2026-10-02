import type { PluginAdapter } from "../adapter.js";

// Names in FabFilter's per-band form ("Band 1 Drive", "Band 1 Style"); medium confidence, the global ones loosest.
export const saturn2: PluginAdapter = {
  id: "saturn2", name: "Saturn 2", vendor: "FabFilter", kind: "effect",
  match: /\bSaturn ?2\b/i,
  overview: "FabFilter's multiband saturation: up to six bands split by crossovers, each with its own Style (28: tube, tape, transformer, amp and effect types), Drive, Feedback, Dynamics, Tone, Mix and Level; then a global Mix and the output. Modulation sources (XLFOs, envelope generators and followers, MIDI, XY pads, sliders) can move any knob. Parameters come per band (Band 1, Band 2…), so Live turns only the configured ones.",
  sections: [
    { name: "Bands", about: "Band N's controls. A band exists only once it's made in the window.",
      parameters: [
        { role: "style", names: /^Band ?\d+ Style$/i, about: "The distortion type: Clean and Warm Tube, tapes, transformers, amps, and effects like Rectify and Smudge." },
        { role: "drive", names: /^Band ?\d+ Drive$/i, about: "How hard the band hits its style." },
        { role: "dynamics", names: /^Band ?\d+ Dynamics$/i, about: "Off center, it compresses or expands around the distortion (expanding brings back punch). Try both sides by ear." },
        { role: "tone", names: /^Band ?\d+ Tone$/i, about: "Darker or brighter distortion." },
        { role: "feedback", names: /^Band ?\d+ Feedback( Freq(uency)?)?$/i, about: "Resonant feedback, from warmth to howl, ringing at its frequency (Hz)." },
        { role: "mix and level", names: /^Band ?\d+ (Mix|Level|Gain|Pan)$/i, about: "The band's dry/wet, output level (dB) and pan." },
        { role: "band switches", names: /^Band ?\d+ (Enabled|Bypass|Mute|Solo)$/i, about: "Bypass, mute and solo, for listening." },
      ] },
    { name: "Crossovers and global", about: "Split points and the whole plug-in.",
      parameters: [
        { role: "crossover", names: /Crossover|^Band ?\d+ (Low |High )?Freq(uency)?$/i, about: "Where bands split, Hz." },
        { role: "global mix", names: /^(Global )?Mix$/i, about: "Dry/wet of everything: parallel saturation." },
        { role: "in and out", names: /^(Input|Output) (Level|Gain|Pan)$/i, about: "dB in and out; output pan." },
        { role: "quality", names: /^(High Quality|HQ|Oversampling)/i, about: "Oversampling: less aliasing on bright, driven sounds, more CPU." },
        { role: "modulation", names: /XLFO|\bEG ?\d|Env(elope)? ?Fol|Slider ?\d|\bXY ?\d/i, about: "The modulation sources' own settings; a source moves only what it's connected to." },
      ] },
  ],
  recipes: [
    { name: "Bass: grit up top, clean lows", how: "Two bands split at 120–200 Hz. Low band clean (no drive, or Clean Tube lightly). Upper band Warm Tube or a tape style, Drive about halfway, Tone a little bright, Mix 60–80%; level-match with its Level." },
    { name: "Drum bus glue", how: "One band, a tape style, Drive a quarter of the way, Dynamics nudged to its compressing side, Mix 40–60%; Output down to match." },
    { name: "Vocal warmth", how: "One band, Warm Tube, Drive low, Tone slightly dark, Mix 30–40%." },
    { name: "Broken lo-fi", how: "An effect style (Rectify, Smudge), Drive high, Feedback up with its frequency at 1–3 kHz, an XLFO slowly moving Drive; global Mix 50%." },
    { name: "Parallel on the mix bus", how: "Global Mix 15–25%, a tape style, Drive moderate, High Quality on: density without losing transients." },
  ],
  beyond: "In Saturn's window (Kumi can open it), or the producer's to do: adding and removing bands (click in the band area, drag crossovers), connecting modulation (drag a source's handle onto a knob), XLFO steps and envelope shapes, MIDI learn, presets (.ffp files, its preset menu). A band that hasn't been made does nothing, whatever its parameters say.",
  folders: { presets: { mac: "~/Documents/FabFilter/Presets/Saturn 2", windows: "~/Documents/FabFilter/Presets/Saturn 2" } },
};
