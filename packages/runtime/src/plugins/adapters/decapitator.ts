import type { PluginAdapter } from "../adapter.js";

// Names as on its face ("Drive", "Style", "Low Cut", "High Cut", "Thump", "Steep", "Tone", "Punish", "Mix", "Output",
// "Auto"); the patterns allow joined words ("LowCut").
export const decapitator: PluginAdapter = {
  id: "decapitator", name: "Decapitator", vendor: "Soundtoys", kind: "effect",
  match: /\bDecapitator\b/i,
  overview: "Soundtoys' analog saturator. Five Styles model hardware: A (Ampex 350 tape preamp), E (EMI/Chandler TG channel), N (Neve 1057 input), T and P (Thermionic Culture Vulture, triode and pentode). Drive pushes the circuit; Low Cut and High Cut shape it (Thump adds a bump at the low cut, Steep steepens the high cut); Tone tilts dark to bright; Punish adds 20 dB of drive; Mix blends in the dry; Output sets the level, and Auto ties it to Drive. Small: every control is a parameter.",
  sections: [
    { name: "Controls", about: "As on its face.",
      parameters: [
        { role: "drive", names: /^Drive$/i, about: "0–10: how hard the circuit is pushed." },
        { role: "style", names: /^Style$/i, about: "A full and smooth, E bright and crisp, N thick in the mids, T and P aggressive (P the most)." },
        { role: "filters", names: /^(Low|High) ?Cut$/i, about: "Hz: what's cut from the lows and the top." },
        { role: "filter switches", names: /^(Thump|Steep)$/i, about: "Thump: a resonant bump at the low cut. Steep: a steeper high cut." },
        { role: "tone", names: /^Tone$/i, about: "Dark to bright; the center is neutral." },
        { role: "punish", names: /^Punish$/i, about: "On: 20 dB more drive, for destruction." },
        { role: "mix", names: /^Mix$/i, about: "Dry/wet, 0–100%: parallel saturation in place." },
        { role: "output", names: /^(Output|Auto)$/i, about: "Output in dB; Auto lowers it as Drive rises, for fair comparisons." },
      ] },
  ],
  recipes: [
    { name: "Drum bus smash", how: "Style N or E, Drive 6–8, Mix 25–35%, High Cut 10 kHz; Punish on for more. Auto on to judge it fairly." },
    { name: "Bass growl, clean sub", how: "Style T or P, Drive 4–6, Low Cut 80–120 Hz with Thump, Tone a little bright, Mix 40–60%: the dry keeps the sub, the wet growls." },
    { name: "Vocal grit", how: "Style A, Drive 3–5, High Cut 8–10 kHz with Steep, Mix 30–40%, Auto on." },
    { name: "Synth warmth", how: "Style A or N, Drive 2–3, Mix 100%, Tone a step toward dark." },
    { name: "Telephone", how: "Style E, Drive 7, Low Cut 400 Hz, High Cut 3 kHz with Steep, Punish on, Mix 100%." },
  ],
  beyond: "Every control is a parameter; presets are in its window's preset menu.",
};
