import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** The shape of Live 12's default Drum Sampler preset, cut down. */
export const DRUM_SAMPLER_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0_12402">
	<DrumCell>
		<LastPresetRef>
			<Value>
				<FilePresetRef Id="0"><FileRef><Path Value="/Core Library/Defaults/Instruments/Drum Sampler.adv" /></FileRef></FilePresetRef>
			</Value>
		</LastPresetRef>
		<UserSample>
			<Value />
		</UserSample>
		<Voice_Gain Value="1" />
	</DrumCell>
</Ableton>
`;

export function liveResources(): string {
  const folder = mkdtempSync(join(tmpdir(), "live-resources-"));
  mkdirSync(join(folder, "Core Library", "Defaults", "Instruments"), { recursive: true });
  writeFileSync(join(folder, "Core Library", "Defaults", "Instruments", "Drum Sampler.adv"), gzipSync(DRUM_SAMPLER_TEMPLATE));
  return folder;
}
