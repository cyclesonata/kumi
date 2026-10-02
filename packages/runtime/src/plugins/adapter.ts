export interface PluginParameterHint { role: string; names: RegExp; about: string }
export interface PluginAdapter {
  id: string; name: string; vendor: string;
  kind: "instrument" | "effect";
  /** Live's name for the device (the plug-in's own name, maybe with a format or version suffix): what picks this adapter. */
  match: RegExp;
  /** A few lines: what it is, its architecture and signal flow. */
  overview: string;
  /** Its parameters as hosts see them, by section: what each does, the names to expect (a forgiving pattern), and its unit in words. */
  sections: { name: string; about: string; parameters: PluginParameterHint[] }[];
  /** Sound-design moves that work in it (a reese, a pluck, a neuro growl; for effects, mixing and mastering moves). */
  recipes: { name: string; how: string }[];
  /** What isn't a host parameter (wavetable editing, mod matrix routing, FX order, adding modules, the assistant) and how to get there: the plug-in's own window (Kumi can open it), its menus, files Kumi can write, or the producer. */
  beyond: string;
  /** Its user folders, per OS (~ for the home folder), where presets and wavetables go. Only folders you're confident of. */
  folders?: { presets?: { mac?: string; windows?: string }; wavetables?: { mac?: string; windows?: string } };
  /** It reads single-cycle wavetables from WAV files: samples per frame, most frames, and whether it reads Serum's "clm " chunk or plain frames. */
  wavetable?: { frame: number; maxFrames: number; format: "clm" | "plain" };
}
