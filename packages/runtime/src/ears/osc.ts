/**
 * The little of Open Sound Control that Kumi's listening device speaks: messages of ints, floats and
 * strings, as Max's udpsend and udpreceive send and read them. Big-endian, every part padded to four bytes.
 */

export type OscArg = number | string | { float: number };

export interface OscMessage { address: string; args: (number | string)[] }

const pad = (length: number) => (4 - (length % 4)) % 4;

function oscString(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  // At least one NUL ends the string, then NULs up to a multiple of four.
  return Buffer.concat([bytes, Buffer.alloc(1 + pad(bytes.length + 1))]);
}

/** A message: whole numbers go as ints, others as floats (`{ float: 2 }` sends 2 as a float), text as strings. */
export function encodeOsc(address: string, args: readonly OscArg[] = []): Buffer {
  let tags = ",";
  const parts: Buffer[] = [];
  for (const arg of args) {
    if (typeof arg === "string") { tags += "s"; parts.push(oscString(arg)); continue; }
    const value = typeof arg === "number" ? arg : arg.float;
    const whole = typeof arg === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    const bytes = Buffer.alloc(4);
    if (whole) { tags += "i"; bytes.writeInt32BE(value); } else { tags += "f"; bytes.writeFloatBE(value); }
    parts.push(bytes);
  }
  return Buffer.concat([oscString(address), oscString(tags), ...parts]);
}

/** A message read back; undefined for anything that isn't one (a bundle's messages come out one by one through decodeOscPacket). */
export function decodeOsc(packet: Buffer): OscMessage | undefined {
  return decodeOscPacket(packet)[0];
}

/** Every message in a packet: one, or a bundle's. */
export function decodeOscPacket(packet: Buffer): OscMessage[] {
  try {
    if (packet.length >= 16 && packet.toString("latin1", 0, 8) === "#bundle\0") {
      const messages: OscMessage[] = [];
      for (let at = 16; at + 4 <= packet.length;) {
        const size = packet.readInt32BE(at); at += 4;
        if (size <= 0 || at + size > packet.length) break;
        messages.push(...decodeOscPacket(packet.subarray(at, at + size)));
        at += size;
      }
      return messages;
    }
    const [address, afterAddress] = readString(packet, 0);
    if (!address.startsWith("/")) return [];
    if (afterAddress >= packet.length) return [{ address, args: [] }];
    const [tags, afterTags] = readString(packet, afterAddress);
    if (!tags.startsWith(",")) return [{ address, args: [] }];
    const args: (number | string)[] = [];
    let at = afterTags;
    for (const tag of tags.slice(1)) {
      switch (tag) {
        case "i": args.push(packet.readInt32BE(at)); at += 4; break;
        case "f": args.push(packet.readFloatBE(at)); at += 4; break;
        case "h": args.push(Number(packet.readBigInt64BE(at))); at += 8; break;
        case "d": args.push(packet.readDoubleBE(at)); at += 8; break;
        case "s": case "S": { const [text, next] = readString(packet, at); args.push(text); at = next; break; }
        case "T": args.push(1); break;
        case "F": case "N": args.push(0); break;
        default: return [{ address, args }];
      }
    }
    return [{ address, args }];
  } catch { return []; }
}

function readString(packet: Buffer, from: number): [string, number] {
  let end = packet.indexOf(0, from);
  if (end < 0) end = packet.length;
  const text = packet.toString("utf8", from, end);
  return [text, end + 1 + pad(end + 1 - from)];
}
