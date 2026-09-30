/**
 * A make_changes plan as the model writes it: each element of the input's top-level "steps" array
 * is handed on as soon as it's whole, so its change can start while later steps are still being
 * written. Anything the scan can't follow just ends it; the whole input settles the plan anyway.
 */
export function stepScanner(onStep: (step: unknown) => void): (delta: string) => void {
  let text = "";
  let at = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  /** The latest string in the top-level object: the key of the value that follows it. */
  let key: string | undefined;
  let inSteps = false;
  let stepStart = -1;
  let broken = false;
  return (delta) => {
    if (broken) return;
    text += delta;
    for (; at < text.length; at++) {
      const char = text[at]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") {
          inString = false;
          if (depth === 1) {
            try { key = JSON.parse(text.slice(stringStart, at + 1)) as string; } catch { broken = true; return; }
          }
        }
        continue;
      }
      if (char === "\"") { inString = true; stringStart = at; continue; }
      if (char === "{" || char === "[") {
        if (depth === 1 && char === "[" && key === "steps") inSteps = true;
        else if (inSteps && depth === 2 && char === "{") stepStart = at;
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;
        if (depth < 0) { broken = true; return; }
        if (inSteps && depth === 2 && stepStart >= 0 && char === "}") {
          let step: unknown;
          try { step = JSON.parse(text.slice(stepStart, at + 1)); } catch { broken = true; return; }
          stepStart = -1;
          onStep(step);
        } else if (inSteps && depth === 1) inSteps = false;
      }
    }
    // What's been scanned is kept only while a step is being written.
    if (stepStart < 0 && !inString) { text = ""; at = 0; }
  };
}
