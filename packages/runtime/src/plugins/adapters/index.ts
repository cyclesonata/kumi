import type { PluginAdapter } from "../adapter.js";
import { decapitator } from "./decapitator.js";
import { ott } from "./ott.js";
import { ozone12 } from "./ozone12.js";
import { pigments } from "./pigments.js";
import { proL2 } from "./prol2.js";
import { proQ4 } from "./proq4.js";
import { saturn2 } from "./saturn2.js";
import { serum2 } from "./serum2.js";
import { supermassive } from "./supermassive.js";
import { vital } from "./vital.js";

export const ADAPTERS: readonly PluginAdapter[] = [serum2, vital, ozone12, proQ4, proL2, saturn2, ott, supermassive, decapitator, pigments];
