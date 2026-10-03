import type { PluginAdapter } from "../adapter.js";

// Names: Pro-Q 3's host names ("Band 1 Used", "Band 1 Frequency", "Band 1 Dynamic Range"), which Pro-Q 4 is taken
// to keep; its spectral and character controls are matched loosely.
export const proQ4: PluginAdapter = {
  id: "proq4", name: "Pro-Q 4", vendor: "FabFilter", kind: "effect",
  match: /\bPro-?Q ?4\b/i,
  overview: "FabFilter's EQ: up to 24 bands, each a group of parameters (Band 1 … Band 24). A band does nothing until it's Used. Each has a shape, frequency, gain, Q, slope and stereo placement, and can be dynamic (its gain moves with its range's level, or a side chain's) or spectral (new in 4: it acts on single resonances inside its range). Globally: processing mode, Character, output. Hundreds of parameters, so Live turns only the configured ones: configure the bands you use.",
  sections: [
    { name: "Bands", about: "Band N's controls. Turn Used on first.",
      parameters: [
        { role: "used", names: /^Band ?\d+ Used$/i, about: "On creates the band, off removes it. Nothing else on the band works while it's off." },
        { role: "enabled", names: /^Band ?\d+ Enabled$/i, about: "Bypasses the band, keeping its settings." },
        { role: "frequency", names: /^Band ?\d+ Freq(uency)?$/i, about: "Hz, 10 Hz–30 kHz." },
        { role: "gain", names: /^Band ?\d+ Gain$/i, about: "dB, ±30 (ignored by cuts, notches and band-pass)." },
        { role: "q", names: /^Band ?\d+ Q$/i, about: "0.025–40, higher is narrower; on cuts and shelves, the corner's resonance." },
        { role: "shape", names: /^Band ?\d+ Shape$/i, about: "Bell, Low Shelf, Low Cut, High Shelf, High Cut, Notch, Band Pass, Tilt Shelf, Flat Tilt (and Pro-Q 4's newer ones)." },
        { role: "slope", names: /^Band ?\d+ Slope$/i, about: "dB/oct for cuts and shelves: 6 to 96, or Brickwall." },
        { role: "stereo placement", names: /^Band ?\d+ (Stereo )?Placement$/i, about: "Stereo, Left, Right, Mid or Side." },
      ] },
    { name: "Dynamics and spectral", about: "Per band. A dynamic band's gain moves from Gain toward Gain + Range as its level goes past Threshold.",
      parameters: [
        { role: "dynamics on", names: /^Band ?\d+ Dynamics? (Enabled|On)$/i, about: "Makes the band dynamic." },
        { role: "range", names: /^Band ?\d+ (Dynamic )?Range$/i, about: "dB. Negative cuts when loud, positive boosts when loud. Gain 0 with Range -6: up to 6 dB off, only when it's loud." },
        { role: "threshold", names: /^Band ?\d+ (Threshold|Dynamics? Auto|Auto Threshold)$/i, about: "dB; Auto sets it from the music." },
        { role: "timing", names: /^Band ?\d+ (Attack|Release)$/i, about: "How fast the gain follows." },
        { role: "side chain", names: /^Band ?\d+ Side ?Chain/i, about: "The band follows the side-chain input instead of itself: duck the bass's lows when the kick hits." },
        { role: "spectral", names: /^Band ?\d+ Spectral/i, about: "Pro-Q 4's spectral dynamics: acts per frequency inside the band, taming single resonances." },
      ] },
    { name: "Global", about: "The whole EQ.",
      parameters: [
        { role: "processing mode", names: /^Processing (Mode|Resolution)$/i, about: "Zero Latency (default), Natural Phase (analog-like phase, small latency), Linear Phase (no phase shift; latency and pre-ringing, their length set by Resolution)." },
        { role: "character", names: /^Character( Mode)?$/i, about: "Clean, or analog-style saturation (Subtle, Warm)." },
        { role: "output", names: /^Output (Level|Gain|Pan)$/i, about: "Output level (dB) and pan." },
        { role: "gain scale and auto gain", names: /^(Gain ?Scale|Auto ?Gain)$/i, about: "Gain Scale scales every band's gain (100% is as set). Auto Gain keeps loudness even." },
      ] },
  ],
  recipes: [
    { name: "Clean lows", how: "Used on, Shape Low Cut, Slope 24 or 48 dB/oct: 25–35 Hz on kick and bass, 100–200 Hz on pads, leads and vocals that don't need lows." },
    { name: "Harshness only when it's there", how: "Bell at 2.5–4 kHz, Q 2–3, Gain 0, dynamics on, Range -4 to -6 dB, Auto threshold. For many narrow resonances, spectral instead." },
    { name: "Kick and bass", how: "On the bass: Bell or Low Shelf at the kick's fundamental (50–80 Hz), dynamic, following the side chain (the kick), Range -4 to -8 dB, fast attack and release." },
    { name: "Vocal air and de-ess", how: "High Shelf at 10–12 kHz, +2 dB, Q 0.7. A dynamic Bell at 6–8 kHz, Range -3 to -6 dB." },
    { name: "Mid/side on a master", how: "Low Cut on Side at 100–150 Hz (mono lows), Bell on Mid at 250–350 Hz -1 dB, High Shelf on Side at 8–10 kHz +1 to +1.5 dB. Natural or Linear Phase." },
  ],
  beyond: "Not parameters: EQ Match (match a reference's spectrum), EQ Sketch, Spectrum Grab, the analyzer, the instance list (the Set's other Pro-Q 4s) and soloing a band to listen: in Pro-Q's window (Kumi can open it), or the producer's to do. The side-chain source is chosen in Live's plug-in device (its Sidechain section). Presets are .ffp files, saved from Pro-Q's preset menu.",
  folders: { presets: { mac: "~/Documents/FabFilter/Presets/Pro-Q 4", windows: "~/Documents/FabFilter/Presets/Pro-Q 4" } },
};
