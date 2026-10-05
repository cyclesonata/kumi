// Run from the repository root; stdout is html-fastpaths.json. No source build is changed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const source = readFileSync(resolve(process.env.KUMI_TS_REFERENCE ?? '.', 'packages/runtime/src/web/html.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { htmlToText, readHtml } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const base = 'https://example.com/guide/';
const cases = [
  '<div><p>Plain ASCII with single spaces.</p><p>Another paragraph.</p></div>',
  '<DIV><P>Uppercase</P><p2>numbered name</p2><custom-tag>custom</custom-tag><pÉ>Unicode name</pÉ></DIV>',
  '<p title="a > b">Quoted attribute</p><p hidden>hidden</p><p aria-hidden="false">shown</p><p/>after',
  '<p>one  two\tthree\nfour\rfive\v six\fseven</p><p>α\u00a0β\u2003γ\u2028δ</p>',
  '<p>one\ufefftwo\u0085three</p>',
  '<p>&amp; &unknown; &#65; &#x1f600;</p><textarea>&lt;literal&gt;</textarea>',
  '<h1><div>heading starts</div></h1><ul><li><div>list starts</div></li></ul><blockquote><p>quote starts</p></blockquote>',
  `<p>${'é😀'.repeat(20)}</p><ul><li><br>after marker</li><li>next</li></ul>`,
  '<pre><code class="language-rust">\n  let x = 1;\n\n</code></pre><p>tail</p>',
  '<script>"<p>hidden"</script><style>hidden</style><textarea>shown</textarea><title>Title</title><noscript>hidden</noscript>',
  '<nav>hidden<nav>nested</nav></nav><aside>hidden</aside><main><p>visible</p></main>',
  '<p>a<br>b<hr>c<img alt="an image" src="/image.png"></p><p>x<sup>2</sup> + H<sub>2</sub>O</p>',
  '<p><a href="/a">first</a> and <a href="/a">second</a>, <a href="/b">last</p>',
  '<div>before<!-- hidden --><![CDATA[hidden]]><?other?><!other><3 malformed</div>',
];
console.log(JSON.stringify(cases.map(html => ({ html, base, text: htmlToText(html, base), read: readHtml(html, base) })), null, 2));
