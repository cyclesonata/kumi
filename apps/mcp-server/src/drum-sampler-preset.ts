/**
 * Drum Sampler presets that hold a sample. Live 12's Drum Sampler has no scripting call that takes a
 * sample, and Live makes a Simpler of any sample the Browser loads onto a pad. A preset does it: Live's
 * own default Drum Sampler preset, with the sample in its UserSample, written where the Browser sees it
 * (the User Library) and loaded onto the pad as a Drum Sampler. The preset is only a carrier; once
 * loaded, the device lives in the Set and the preset file can go.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DrumSamplerTemplate {
  /** Live's default Drum Sampler preset, as XML. */
  xml: string;
  /** Where Live keeps its built-in Drum Sampler, which the preset names as its origin. */
  builtinDevicePath: string;
}

/** Live's resources folders, newest-looking first: the app bundles on macOS, ProgramData on Windows. */
export function liveResourceFolders(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.ABLETON_MCP_LIVE_RESOURCES) return [env.ABLETON_MCP_LIVE_RESOURCES];
  const list = (folder: string) => { try { return readdirSync(folder).sort().reverse(); } catch { return []; } };
  if (platform === "win32") {
    const programData = env.ProgramData ?? "C:\\ProgramData";
    return list(join(programData, "Ableton")).filter((name) => /^Live /i.test(name)).map((name) => join(programData, "Ableton", name, "Resources"));
  }
  return list("/Applications").filter((name) => /^Ableton Live.*\.app$/i.test(name)).map((name) => join("/Applications", name, "Contents", "App-Resources"));
}

/** The first installed Live with a default Drum Sampler preset; undefined without one (Live 11 and earlier). */
export function findDrumSamplerTemplate(folders = liveResourceFolders()): DrumSamplerTemplate | undefined {
  for (const folder of folders) {
    const preset = join(folder, "Core Library", "Defaults", "Instruments", "Drum Sampler.adv");
    if (!existsSync(preset)) continue;
    try { return { xml: gunzipSync(readFileSync(preset)).toString("utf8"), builtinDevicePath: join(folder, "Builtin", "Devices", "Instruments", "Drum Sampler") }; }
    catch { continue; }
  }
  return undefined;
}

/** Live's User Library, where it is by default. */
export function defaultUserLibrary(platform = process.platform, home = homedir()): string {
  return platform === "win32" ? join(home, "Documents", "Ableton", "User Library") : join(home, "Music", "Ableton", "User Library");
}

const attribute = (value: string) => `"${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u001f]/g, (character) => `&#${character.charCodeAt(0)};`)}"`;

/**
 * The template with `samplePath` as its sample, gzipped as Live writes presets. The file reference
 * is absolute, as for a sample outside Live's libraries; Live reads the sample's length itself.
 */
export function drumSamplerPreset(template: DrumSamplerTemplate, sample: { path: string; size: number; modifiedSeconds: number }): Buffer {
  const userSample = `<UserSample>
			<Value>
				<SampleRef Id="0">
					<FileRef>
						<RelativePathType Value="0" />
						<RelativePath Value="" />
						<Path Value=${attribute(sample.path)} />
						<Type Value="1" />
						<LivePackName Value="" />
						<LivePackId Value="" />
						<OriginalFileSize Value="${Math.max(0, Math.floor(sample.size))}" />
						<OriginalCrc Value="0" />
						<SourceHint Value="" />
					</FileRef>
					<LastModDate Value="${Math.max(0, Math.floor(sample.modifiedSeconds))}" />
					<SourceContext />
					<SampleUsageHint Value="0" />
					<DefaultDuration Value="0" />
					<DefaultSampleRate Value="0" />
					<SamplesToAutoWarp Value="1" />
				</SampleRef>
			</Value>
		</UserSample>`;
  const origin = `<LastPresetRef>
			<Value>
				<AbletonDefaultPresetRef Id="0">
					<FileRef>
						<RelativePathType Value="7" />
						<RelativePath Value="Devices/Instruments/Drum Sampler" />
						<Path Value=${attribute(template.builtinDevicePath)} />
						<Type Value="2" />
						<LivePackName Value="" />
						<LivePackId Value="" />
						<OriginalFileSize Value="0" />
						<OriginalCrc Value="0" />
						<SourceHint Value="" />
					</FileRef>
					<DeviceId Name="DrumCell" />
				</AbletonDefaultPresetRef>
			</Value>
		</LastPresetRef>`;
  const empty = /<UserSample>\s*<Value\s*\/>\s*<\/UserSample>/;
  const last = /<LastPresetRef>[\s\S]*?<\/LastPresetRef>/;
  if (!/<DrumCell[\s>]/.test(template.xml) || !empty.test(template.xml) || !last.test(template.xml)) throw new Error("Live's default Drum Sampler preset has a shape the bridge doesn't know");
  // Functions, so a "$" in a path is never read as a replacement pattern.
  return gzipSync(Buffer.from(template.xml.replace(empty, () => userSample).replace(last, () => origin), "utf8"));
}
