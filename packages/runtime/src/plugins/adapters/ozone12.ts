import type { PluginAdapter } from "../adapter.js";

// Names: Ozone starts each parameter with its module (and the module's instance), in a form not confirmed here; the
// patterns need only the module's name and the control's, in that order.
export const ozone12: PluginAdapter = {
  id: "ozone12", name: "Ozone 12", vendor: "iZotope", kind: "effect",
  match: /\bOzone ?12\b/i,
  overview: "iZotope's mastering suite: one plug-in holding a chain of modules, processed in order. The core: Equalizer, Dynamic EQ, Dynamics (a multiband compressor), Imager, Exciter, and the Maximizer last. Also Low End Focus, Clarity, Stabilizer, Master Rebalance, Match EQ, the Vintage modules, and in 12 Stem EQ, Bass Control and Unlimiter (several need Advanced). Parameter names start with their module; a module's parameters do nothing while it isn't in the chain. Advanced also installs each module as its own plug-in (Ozone 12 Maximizer and so on), with the same controls. Hundreds of parameters, so Live turns only the configured ones.",
  sections: [
    { name: "Maximizer", about: "The final limiter: loudness and the peak ceiling.",
      parameters: [
        { role: "threshold", names: /Maximi[sz]er.*Threshold/i, about: "dB. Lower pushes harder into the limiter: louder, more limited (output is made up)." },
        { role: "ceiling", names: /Maximi[sz]er.*(Ceiling|Margin|Output Level)/i, about: "The highest peak out, dB: -1.0 for streaming." },
        { role: "character", names: /Maximi[sz]er.*Character/i, about: "0–10: low is fast and aggressive, high slower and smoother." },
        { role: "mode", names: /Maximi[sz]er.*(Mode|IRC|Style)/i, about: "The IRC algorithm: later ones stay cleaner when pushed; Low Latency for live use." },
        { role: "transients and width", names: /Maximi[sz]er.*(Transient|Upward|Soft ?Clip|Stereo Indep|Independence)/i, about: "Transient Emphasis keeps attacks, Upward Compress lifts quiet parts, Soft Clip shaves peaks before limiting, Stereo Independence lets left and right limit apart (wider, a less steady center)." },
        { role: "true peak", names: /Maximi[sz]er.*True ?Peak/i, about: "On: also catches peaks between samples." },
      ] },
    { name: "Equalizer and Dynamic EQ", about: "Bands with frequency, gain, Q and shape. A Dynamic EQ band moves its gain only while its range is past the threshold.",
      parameters: [
        { role: "eq gain", names: /(?<!Dynamic |Match |Vintage |Stem )(EQ|Equali[sz]er)\b.*Band.*Gain/i, about: "dB per band." },
        { role: "eq frequency", names: /(?<!Dynamic |Match |Vintage |Stem )(EQ|Equali[sz]er)\b.*Band.*Freq/i, about: "Hz per band." },
        { role: "eq q and shape", names: /(?<!Dynamic |Match |Vintage |Stem )(EQ|Equali[sz]er)\b.*Band.*(\bQ\b|Width|Shape|Type)/i, about: "Q (higher is narrower) and shape (bell, shelf, cut)." },
        { role: "dynamic eq", names: /Dynamic EQ.*Band.*(Threshold|Gain|Freq|\bQ\b|Attack|Release|Mode)/i, about: "Threshold (dB), the gain it moves to past it, frequency, Q, timing; cut or boost." },
      ] },
    { name: "Dynamics, Imager, Exciter", about: "Up to four bands each, split by crossovers.",
      parameters: [
        { role: "dynamics", names: /Dynamics.*(Threshold|Ratio|Attack|Release|Knee|Gain)/i, about: "Per band: threshold (dB), ratio, attack and release (ms), knee, makeup gain." },
        { role: "crossovers", names: /(Dynamics|Imager|Exciter).*(Crossover|Split)/i, about: "Where bands split, Hz." },
        { role: "width", names: /Imager.*(Width|Stereoi[sz]e)/i, about: "Width per band, -100% (mono) to +100%; keep the lowest band at or under 0. Stereoize widens narrow parts; check mono." },
        { role: "exciter", names: /Exciter.*(Amount|Drive|Mix|Mode)/i, about: "Per band: the saturation mode (warm, tape, tube, retro…), its amount, and Mix." },
      ] },
    { name: "Tone and balance", about: "Modules that reshape the whole mix's tone or balance, and the chain's levels.",
      parameters: [
        { role: "low end focus", names: /Low End Focus.*(Contrast|Gain|Amount|Mode)/i, about: "Contrast up tightens and punches the lows; down smooths them." },
        { role: "clarity and stabilizer", names: /(Clarity|Stabili[sz]er).*(Amount|Mix|Speed|Tilt)/i, about: "Clarity lifts masked detail; Stabilizer rides the tone toward a target as the song changes. A little goes far." },
        { role: "master rebalance", names: /Rebalance.*(Vocal|Bass|Drum)/i, about: "Level of vocals, bass or drums inside the finished mix, dB." },
        { role: "ozone 12 modules", names: /Stem EQ|Unlimiter|Bass Control/i, about: "Stem EQ: EQ one part (vocals, bass, drums…) inside the mix. Unlimiter: brings back transients a limiter crushed. Bass Control: tightens and focuses the lows." },
        { role: "chain in and out", names: /^(Global\W*)?(Input|Output) ?(Gain|Level)$/i, about: "dB into and out of the whole chain." },
      ] },
  ],
  recipes: [
    { name: "Streaming master", how: "Maximizer last: Ceiling -1.0 dB, True Peak on, Character 3–5. Lower Threshold until the loudest part limits 2–4 dB. Aim for -14 to -9 LUFS integrated by genre: streaming turns louder masters down." },
    { name: "Loud club master", how: "Threshold for 4–6 dB of limiting, Character 1–3, some Transient Emphasis to keep punch, Soft Clip on, Ceiling -0.3 to -1.0 dB. Dynamics low band 2:1, attack 30 ms, release 100 ms to steady the bass. Imager's lowest band (under 120 Hz) toward -100%." },
    { name: "Glue", how: "Dynamics with bands linked: ratio 1.5–2:1, attack 20–30 ms, release 100–200 ms, 1–2 dB of reduction. Exciter in a tape mode at 10–20% mix." },
    { name: "Harsh top, boomy bottom", how: "Dynamic EQ band at 2.5–5 kHz, Q about 2, cutting up to 3 dB only when it gets loud. Equalizer low shelf -1 to -2 dB at 100–150 Hz, or Low End Focus contrast up for tighter lows." },
    { name: "Toward a reference", how: "Match EQ: capture the reference and the mix in Ozone's window, apply 30–60% with smoothing. Or run Master Assistant with the reference track. Then listen to both and set the Maximizer for the same loudness." },
  ],
  beyond: "Master Assistant is a button, not a parameter: in Ozone's window (Kumi can open it) the producer picks a target (streaming, CD, or a reference track), starts it, and plays the loudest 10–20 seconds; Ozone builds a chain and sets the Maximizer. Its result is parameters Kumi can then adjust (configure the new ones). Adding, removing and reordering modules, loading reference tracks, Match EQ's captures and presets are in that window too, or the producer's to do.",
};
