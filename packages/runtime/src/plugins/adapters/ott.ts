import type { PluginAdapter } from "../adapter.js";

// Names: not confirmed here ("Depth", "Time", "In Gain", "Out Gain", "Upwd %", "Downwd %", a gain per band); the
// patterns take short and long forms.
export const ott: PluginAdapter = {
  id: "ott", name: "OTT", vendor: "Xfer Records", kind: "effect",
  match: /^(Xfer )?OTT\b/i,
  overview: "Xfer's free three-band compressor, after the OTT preset of Live's Multiband Dynamics. Each band (high, mid, low) is pushed down above one threshold and pulled up below another, so detail and tails come up and peaks come down: dense, bright, loud. Depth blends the whole effect, Time scales attack and release, In and Out Gain set the levels, and each band has an output gain.",
  sections: [
    { name: "Controls", about: "Its knobs and sliders.",
      parameters: [
        { role: "depth", names: /^Depth$/i, about: "0–100%, the effect's dry/wet: 100% is full OTT, 20–40% the usual touch." },
        { role: "time", names: /^Time$/i, about: "Scales attack and release: lower is snappier and grittier, higher smoother." },
        { role: "in gain", names: /^In(put)? ?Gain$/i, about: "dB into the bands: more drives more compression." },
        { role: "out gain", names: /^Out(put)? ?Gain$/i, about: "dB out: OTT gets loud, so level-match here." },
        { role: "upward", names: /^Up(w(ar)?d)?\b/i, about: "%: how far quiet parts are lifted; lower it to keep noise and tails down." },
        { role: "downward", names: /^(Down(w(ar)?d)?|Dnwd)\b/i, about: "%: how far loud parts are pushed down." },
        { role: "band gains", names: /^(H(igh)?|M(id)?|L(ow)?)[ _]?(Gain|Out(put)?|Level)\b|\b(Gain|Out(put)?) ?(H(igh)?|M(id)?|L(ow)?)$/i, about: "Each band's output, dB: tilt the tone (Low down if it muddies, High down if it hisses)." },
      ] },
  ],
  recipes: [
    { name: "A touch on a synth", how: "Depth 20–35%, Time at its default or a little lower, Out Gain to match the bypassed level: movement and air without flattening it." },
    { name: "Full squash for sound design", how: "Depth 100%, In Gain +3 to +6 dB, Upward and Downward at full, Out Gain down 4–8 dB. An EQ or low cut after it: it lifts hiss, room and tails. Common on growls and resampled basses." },
    { name: "Drums with air", how: "Depth 15–25%, Upward 30–50% so tails don't swell, Downward full; the Low band down 1–3 dB if kicks bloom." },
    { name: "Dense tails", how: "After a reverb or delay, Depth 40–60%: tails come forward and shimmer. Watch the noise floor." },
  ],
  beyond: "OTT is simple: its knobs and sliders are its parameters. What it lacks (crossover points, ratios, attack in ms) needs Live's Multiband Dynamics, where OTT is a preset.",
};
