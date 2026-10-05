// Record the source's collaboration-profile path behavior with both native Node
// path implementations. The source code is unchanged; only node:path's imported
// functions are bound explicitly so both platforms can be checked from one host.
import {readFileSync,writeFileSync} from 'node:fs';
const sourceUrl=new URL('../../../../apps/mcp-server/dist/src/project-semantic.js',import.meta.url);
const source=readFileSync(sourceUrl,'utf8').replace('from "./project.js"',`from ${JSON.stringify(new URL('./project.js',sourceUrl).href)}`);
const baseline=JSON.parse(readFileSync(new URL('./project_semantic_oracle.json',import.meta.url))).cases[0];
const paths=['/tmp/Project/Samples/Beat.wav','\\tmp\\Project\\Samples\\Beat.wav','C:/Project/Samples/Beat.wav','C:\\Project\\Samples\\Beat.wav','C:Beat.wav','C:','Beat.wav','Samples/Beat.wav','./Samples/../Beat.wav','//server/share/Beat.wav','\\\\server\\share\\Beat.wav','file:///tmp/Beat.wav','smb://server/share/Beat.wav','/','/tmp/Beat.wav/'];
const platforms={};
for(const platform of ['posix','win32']){
 const code=source.replace('import { basename, dirname, isAbsolute, relative, resolve } from "node:path";',`import path from "node:path"; const { basename, dirname, isAbsolute, relative, resolve }=path.${platform};`);
 if(code===source)throw new Error('source path import changed');
 const {createSemanticProjectSnapshot}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 platforms[platform]=paths.map(path=>{const snapshot=structuredClone(baseline.snapshot);snapshot.tracks[0].clips[0].filePath=path;const artifact=createSemanticProjectSnapshot(snapshot,baseline.options);return {path,identity:artifact.artifact,dependencies:artifact.records.filter(row=>row.kind==='dependency')};});
}
writeFileSync(new URL('./project_semantic_paths_oracle.json',import.meta.url),JSON.stringify(platforms)+'\n');
console.log(`${paths.length} source path cases on each platform`);
