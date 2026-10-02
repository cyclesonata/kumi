import type { PluginAdapter } from "../adapter.js";

// Names as FabFilter labels its controls ("Gain", "Output Level", "Style", "Lookahead", "Channel Link Transients");
// fairly sure of the main ones, less of the switches'.
export const proL2: PluginAdapter = {
  id: "prol2", name: "Pro-L 2", vendor: "FabFilter", kind: "effect",
  match: /\bPro-?L ?2\b/i,
  overview: "FabFilter's limiter. Gain drives the input into it, Output Level is the ceiling, Style picks the algorithm, Lookahead, Attack and Release time it, and Channel Link sets how much left and right limit together. True Peak Limiting and oversampling stop overs between samples. Loudness meters in its window; Unity Gain plays it back at the input level, so you judge the sound, not the volume.",
  sections: [
    { name: "Limiter", about: "What shapes the sound.",
      parameters: [
        { role: "gain", names: /^(Input )?Gain$/i, about: "dB into the limiter: this sets the loudness." },
        { role: "output level", names: /^Output( Level)?$/i, about: "The ceiling, dB: -1.0 for streaming, with True Peak on." },
        { role: "style", names: /^(Style|Algorithm|Mode)$/i, about: "Transparent (clean at light limiting), Punchy and Dynamic (keep transients), Allround and Modern (most masters), Aggressive (loudest, can crunch), Bus (gentle), Safe (never distorts, can pump)." },
        { role: "lookahead", names: /^Look ?ahead$/i, about: "ms, 0–5. More is smoother and adds latency; little or none keeps punch but can crackle." },
        { role: "attack and release", names: /^(Attack|Release)$/i, about: "How fast it reacts and recovers. Short release is louder and grainier; long is cleaner but pumps." },
        { role: "channel link", names: /^Channel Link/i, about: "Transients and Release, %: 100% limits both sides alike (a steady image); less lets each limit alone (louder, wider, can wander)." },
      ] },
    { name: "Output", about: "Peaks, quality, level matching, export.",
      parameters: [
        { role: "true peak", names: /^True Peak/i, about: "On: the ceiling holds between samples too." },
        { role: "oversampling", names: /^Oversampling$/i, about: "Off, or 2x up to 32x: cleaner, truer peaks for more CPU; 4x suits a master." },
        { role: "unity gain", names: /^Unity Gain$/i, about: "On: plays back at the input level, so you hear only what the limiting does. Off before export." },
        { role: "dither", names: /^(Dither(ing)?( Bits)?|Noise Shaping)$/i, about: "Only for a final 16- or 24-bit export, never mid-chain." },
        { role: "dc filter", names: /^DC (Offset )?Filter$/i, about: "Removes DC offset before limiting." },
      ] },
  ],
  recipes: [
    { name: "Streaming master", how: "Style Modern (or Allround), Output Level -1.0 dB, True Peak on, Oversampling 4x, Lookahead 1–2 ms. Raise Gain until the loudest bars limit 2–4 dB. Aim for -14 to -9 LUFS integrated by genre; check with Unity Gain." },
    { name: "Loud club or bass master", how: "Style Aggressive or Modern, Gain for 4–6 dB of limiting, Lookahead 0.5–1 ms, short Release, Channel Link Transients 50–75%, Oversampling 8x. If it crackles, take a dB of Gain off, or clip before it (Saturn, a clipper) so Pro-L does less." },
    { name: "Bus peaks", how: "Style Bus or Punchy, Gain 1–3 dB, Lookahead 0–0.5 ms, Output Level -0.3 dB: only the peaks." },
    { name: "Safety limiter", how: "Style Safe or Transparent, Gain 0 dB, Output Level -1.0 dB, True Peak on: only overs get touched." },
  ],
  beyond: "Everything that shapes the sound is a parameter. In its window only: the loudness meters and their targets, display options, and presets (.ffp files, its preset menu).",
  folders: { presets: { mac: "~/Documents/FabFilter/Presets/Pro-L 2", windows: "~/Documents/FabFilter/Presets/Pro-L 2" } },
};
