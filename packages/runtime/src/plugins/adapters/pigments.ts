import type { PluginAdapter } from "../adapter.js";

// Names: low confidence. Arturia spells names out with their module first ("Engine 1 …", "Filter 1 …"), in a form not
// confirmed here, so the patterns need only the module and the control, in that order.
export const pigments: PluginAdapter = {
  id: "pigments", name: "Pigments", vendor: "Arturia", kind: "instrument",
  match: /\bPigments\b/i,
  overview: "Arturia's polysynth. Two main engines, each Virtual Analog, Wavetable, Sample (with granular) or Harmonic (newer versions add types), plus a utility engine (noise and samples). The engines feed two filters (in series or parallel), then the amp and three FX buses (A, B and an aux send), up to three effects each. Modulation: envelopes (the first drives the amp), LFOs, function generators, random sources, combinators, macros and a sequencer/arpeggiator; drag a source onto a knob. Hundreds of parameters, so Live turns only the configured ones.",
  sections: [
    { name: "Engines", about: "Engines 1 and 2. What a control does depends on the engine type, picked in the window.",
      parameters: [
        { role: "engine level", names: /Eng(ine)? ?[1-3]\b.*(Vol(ume)?|Level)/i, about: "The engine's output." },
        { role: "engine pitch", names: /Eng(ine)? ?[12]\b.*\b(Coarse|Fine|Tune|Pitch|Oct(ave)?)\b/i, about: "Semitones and cents." },
        { role: "wavetable position", names: /Eng(ine)? ?[12]\b.*(Position|\bPos\b|Morph)/i, about: "Wavetable engine: where in the table, the main timbre move. Sample engine: where in the sample." },
        { role: "unison", names: /Eng(ine)? ?[12]\b.*(Unison|Detune|Spread)/i, about: "Unison voices, detune and spread." },
        { role: "filter send", names: /Eng(ine)? ?[12]\b.*(Filter|Filt) ?(Mix|Balance|Route|Routing|Send)/i, about: "How much goes to Filter 1 against Filter 2." },
      ] },
    { name: "Filters and amp", about: "Two filters; the type (multimode, SEM, ladders, comb, formant, phaser, surgeon…) is picked in the window.",
      parameters: [
        { role: "cutoff", names: /F(ilter|ilt|lt)? ?[12]\b.*(Cutoff|Freq)/i, about: "Hz." },
        { role: "resonance", names: /F(ilter|ilt|lt)? ?[12]\b.*Res(o(nance)?)?\b/i, about: "0–100%." },
        { role: "filter drive and level", names: /F(ilter|ilt|lt)? ?[12]\b.*(Drive|Gain|Mix|Volume)/i, about: "Drive into it, its level." },
        { role: "routing", names: /Filter ?Routing|Filter ?(Series|Parallel)|F1 ?F2/i, about: "Series, parallel, or a blend between." },
        { role: "amp envelope", names: /(Env(elope)? ?1|VCA|Amp ?Env).*(Attack|Decay|Sustain|Release)/i, about: "The amp: Attack, Decay, Release in ms or s; Sustain 0–100%." },
      ] },
    { name: "Modulation and FX", about: "Sources move only what they're routed to.",
      parameters: [
        { role: "mod envelopes", names: /Env(elope)? ?[23]\b.*(Attack|Decay|Sustain|Release)/i, about: "Same stages, for filter, pitch or anything." },
        { role: "lfo", names: /LFO ?[1-3]\b.*(Rate|Freq|Sync)/i, about: "Hz free, or a note value synced." },
        { role: "macro", names: /^(Macro ?[1-4]|M[1-4])\b/i, about: "The four macros: whatever the preset routed them to." },
        { role: "fx mix", names: /\b(FX|Bus|Aux)\b.*(Dry ?\/? ?Wet|Mix|Send|Return|Level|Volume)/i, about: "Each effect's dry/wet, the aux send, the buses' levels." },
        { role: "master", names: /^(Master|Main|Output) ?(Vol(ume)?|Level|Gain)?$/i, about: "Output level." },
      ] },
  ],
  recipes: [
    { name: "Wavetable growl bass", how: "Engine 1 Wavetable on a vocal or growl table, LFO 1 synced 1/8 on Position (40–60%). Engine 2 a sine an octave down for weight. Filter 1 a formant or comb type, LFO 2 on its cutoff. Mono, glide 40 ms. Bus A: Distortion, then a compressor." },
    { name: "Supersaw", how: "Engine 1 Virtual Analog saw, unison 7, detune a third of the way up, spread full. Filter 1 low-pass at 6–8 kHz. Amp Attack 5 ms, Release 400 ms. Chorus 25%, Reverb 20%." },
    { name: "Pluck", how: "Filter 1 low-pass at 300 Hz, Resonance 20%; envelope 2 to its cutoff, large amount: Attack 0, Decay 250 ms, Sustain 0. Amp Decay 400 ms, Sustain 0, Release 300 ms. Delay 1/8 dotted, 20%." },
    { name: "Granular texture", how: "Engine 1 Sample in granular mode on a long texture: grains 100–200 ms, high density, position moved by a slow LFO (0.1 Hz), some random spray. Amp Attack 1 s, Release 3 s. Reverb 40%." },
    { name: "Evolving pad", how: "A function generator over 2–4 bars, looping, on Wavetable Position and Filter 1 cutoff; engines 1 and 2 a few cents apart. Amp Attack 0.8 s, Release 2.5 s. Chorus 30%, Reverb 35%." },
  ],
  beyond: "Not parameters: each engine's type and its wavetable or sample (the engine's browser), filter types, modulation routing (drag a source onto a knob, or the modulation view), LFO and function shapes, sequencer and arpeggiator patterns, which effects sit on each bus and their order. Do these in Pigments' window (Kumi can open it) or ask the producer. A wavetable Kumi makes is imported from the Wavetable engine's browser; presets are saved from Pigments' own browser.",
};
