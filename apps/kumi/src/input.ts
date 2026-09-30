import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (enabled: boolean) => unknown };

/** Node 24's batched-paste fast path can lose wrapped cursor rows. Deliver complete
 * Unicode code points as distinct input chunks, retaining readline's normal editor. */
export class KeyInput extends Readable {
  readonly isTTY = true;
  private readonly decoder = new StringDecoder("utf8");
  private readonly data = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (const character of text) this.push(Buffer.from(character));
  };
  private readonly end = () => { this.data(this.decoder.end()); this.push(null); };
  private readonly failed = (error: Error) => { this.destroy(error); };
  constructor(private readonly source: TerminalInput) {
    // Object mode prevents adjacent buffered characters being recombined on resume.
    super({ objectMode: true });
    source.on("data", this.data); source.once("end", this.end); source.on("error", this.failed);
  }
  get isRaw() { return Boolean(this.source.isRaw); }
  setRawMode(enabled: boolean) { this.source.setRawMode?.(enabled); return this; }
  override _read() {}
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.source.removeListener("data", this.data); this.source.removeListener("end", this.end); this.source.removeListener("error", this.failed);
    this.source.pause(); callback(error);
  }
}
