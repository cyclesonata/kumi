/**
 * A web page as text a model reads well: headings, paragraphs, lists, code and tables kept, links
 * as [text](address), and scripts, styles, navigation and hidden parts left out. The page's main
 * part (<main>, or its one <article>) is read when it has one.
 */

export interface PageText {
  title?: string;
  description?: string;
  text: string;
  /** It has scripts and hardly any text: a browser builds what it shows. */
  scripted: boolean;
}

/** Read as text, not markup, to their closing tag. */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "iframe", "noembed", "noframes", "plaintext"]);
/** Left out whole, with what's inside them. */
const SKIP = new Set(["head", "template", "svg", "math", "canvas", "object", "embed", "nav", "footer", "aside", "select", "button", "dialog", "audio", "video", "map", "datalist"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen"]);
/** Elements that start on a line of their own. */
const BLOCK = new Set(["address", "article", "blockquote", "body", "center", "details", "div", "dl", "fieldset", "figcaption", "figure", "form", "header", "hgroup",
  "html", "legend", "main", "menu", "section", "summary", "caption", "tbody", "thead", "tfoot", "dir"]);

const LATIN = "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", shy: "", zwj: "", zwnj: "", lrm: "", rlm: "",
  mdash: "—", ndash: "–", minus: "−", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›",
  bull: "•", middot: "·", deg: "°", plusmn: "±", micro: "µ", para: "¶", sect: "§", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢", curren: "¤",
  frac12: "½", frac14: "¼", frac34: "¾", sup1: "¹", sup2: "²", sup3: "³", iexcl: "¡", iquest: "¿", ordf: "ª", ordm: "º", not: "¬", macr: "¯", acute: "´", cedil: "¸", uml: "¨", brvbar: "¦",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", lArr: "⇐", rArr: "⇒", hArr: "⇔", le: "≤", ge: "≥", ne: "≠", asymp: "≈", equiv: "≡", infin: "∞", sum: "∑", prod: "∏",
  radic: "√", part: "∂", int: "∫", nabla: "∇", isin: "∈", prop: "∝", ang: "∠", and: "∧", or: "∨", cap: "∩", cup: "∪", sdot: "⋅", lowast: "∗", dagger: "†", Dagger: "‡", prime: "′", Prime: "″",
  alpha: "α", beta: "β", gamma: "γ", Gamma: "Γ", delta: "δ", Delta: "Δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", Theta: "Θ", kappa: "κ", lambda: "λ", Lambda: "Λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", Pi: "Π", rho: "ρ", sigma: "σ", Sigma: "Σ", tau: "τ", phi: "φ", Phi: "Φ", chi: "χ", psi: "ψ", Psi: "Ψ", omega: "ω", Omega: "Ω",
  sharp: "♯", flat: "♭", natural: "♮", hearts: "♥", check: "✓", star: "☆", starf: "★", OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜",
  ...Object.fromEntries(LATIN.map((name, index) => [name, String.fromCodePoint(0xc0 + index)])),
};

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
    }
    return NAMED[name] ?? whole;
  });
}

type Attributes = Record<string, string>;
function attributes(source: string): Attributes {
  const found: Attributes = {};
  for (const match of source.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1]!.toLowerCase();
    if (!(name in found)) found[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return found;
}

/** Roles and class names that mark a site's own furniture (menus, banners, edit links, notices), not what the page says. */
const FURNITURE_ROLES = new Set(["navigation", "banner", "contentinfo", "search", "complementary", "menu", "menubar", "toolbar"]);
const FURNITURE = new Set(["navbox", "navbar", "breadcrumb", "breadcrumbs", "sidebar", "ambox", "noprint", "mw-editsection", "mw-jump-link", "vector-dropdown",
  "vector-page-toolbar", "vector-toc", "mw-indicators", "cookie-banner", "skip-link", "skip-to-content", "sr-only", "visually-hidden", "screen-reader-text"]);
const hidden = (attrs: Attributes) => "hidden" in attrs || attrs["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style ?? "")
  || FURNITURE_ROLES.has((attrs.role ?? "").toLowerCase()) || `${attrs.class ?? ""} ${attrs.id ?? ""}`.toLowerCase().split(/\s+/).some((token) => FURNITURE.has(token));

/** An absolute http(s) address for a link, or undefined for anything else. */
function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || /^(javascript|data|mailto|tel|blob):/i.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

const TAG = /<([a-zA-Z][^\s\/>]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const CLOSE = /<\/([a-zA-Z][^\s\/>]*)\s*>/y;

/**
 * Text built in pieces. Reading a character of a string that's been appended to makes V8 copy the
 * whole string, so the text is kept as chunks and only its end is ever looked at.
 */
class Builder {
  private readonly chunks: string[] = [];
  length = 0;
  push(text: string): void { if (text) { this.chunks.push(text); this.length += text.length; } }
  /** The last `count` characters (fewer when there aren't that many). */
  tail(count: number): string {
    let text = "";
    for (let index = this.chunks.length - 1; index >= 0 && text.length < count; index--) text = this.chunks[index] + text;
    return text.length > count ? text.slice(-count) : text;
  }
  endsWith(suffix: string): boolean { return this.tail(suffix.length) === suffix; }
  /** Takes out everything from `start` on, and gives it back. */
  cut(start: number): string {
    let taken = "";
    while (this.chunks.length && this.length - this.chunks[this.chunks.length - 1]!.length >= start) {
      const chunk = this.chunks.pop()!; this.length -= chunk.length; taken = chunk + taken;
    }
    if (this.length > start && this.chunks.length) {
      const last = this.chunks.pop()!;
      const keep = last.length - (this.length - start);
      this.chunks.push(last.slice(0, keep)); taken = last.slice(keep) + taken; this.length = start;
    }
    return taken;
  }
  trimEnd(): void {
    for (;;) {
      const tail = this.tail(32);
      let end = tail.length;
      while (end > 0 && (tail[end - 1] === " " || tail[end - 1] === "\t")) end--;
      if (end === tail.length) return;
      this.cut(this.length - (tail.length - end));
    }
  }
  toString(): string { return this.chunks.join(""); }
}

/** Markdown-ish text from HTML (`base` resolves its links). */
export function htmlToText(html: string, base: string): string {
  const out = new Builder();
  /** Inside <pre>: whitespace is the text's own; `fresh` just after it opened. */
  let pre = 0;
  let fresh = false;
  /** Left out: the element's name and how deep in its own kind we are. */
  let skipping: { name: string; depth: number } | undefined;
  const lists: { ordered: boolean; index: number }[] = [];
  const links: { href: string | undefined; start: number }[] = [];
  const quotes: number[] = [];
  const cells: number[] = [];
  const scripts: { mark: string; start: number }[] = [];
  const codes: number[] = [];
  /** Inside a heading, which stays one line. */
  let heading = false;
  /** Links already given with their address: later ones are just their words. */
  const linked = new Set<string>();

  /** A heading, list item or quote whose line has only just begun: nothing breaks it before its words. */
  const opening = () => {
    const tail = out.tail(24);
    const marker = /(?:^|\n) *(?:#{1,6} |- |\d+\. |> )$/.exec(tail);
    return Boolean(marker) && (marker![0].startsWith("\n") || tail.length === out.length);
  };
  const newline = () => { if (opening()) return; out.trimEnd(); if (out.length && !out.endsWith("\n")) out.push("\n"); };
  const blank = () => { if (opening()) return; out.trimEnd(); if (!out.length) return; if (!out.endsWith("\n")) out.push("\n"); if (!out.endsWith("\n\n")) out.push("\n"); };
  const write = (text: string) => {
    if (!text) return;
    if (pre) { out.push(fresh ? text.replace(/^\r?\n/, "") : text); fresh = false; return; }
    let words = text.replace(/[\s\u00a0]+/g, " ");
    if (!out.length || out.endsWith("\n") || out.endsWith(" ")) words = words.replace(/^ /, "");
    out.push(words);
  };

  const lower = html.toLowerCase();
  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    const textEnd = lt === -1 ? html.length : lt;
    if (textEnd > at) {
      if (!skipping) write(decodeEntities(html.slice(at, textEnd)));
      at = textEnd;
      if (lt === -1) break;
    }
    // Comments, doctypes and other declarations say nothing to the reader.
    if (html.startsWith("<!--", at)) { const end = html.indexOf("-->", at + 4); at = end === -1 ? html.length : end + 3; continue; }
    if (html.startsWith("<![CDATA[", at)) { const end = html.indexOf("]]>", at); at = end === -1 ? html.length : end + 3; continue; }
    if (html.startsWith("<!", at) || html.startsWith("<?", at)) { const end = html.indexOf(">", at); at = end === -1 ? html.length : end + 1; continue; }
    CLOSE.lastIndex = at;
    const close = CLOSE.exec(html);
    if (close) {
      at = CLOSE.lastIndex;
      const name = close[1]!.toLowerCase();
      if (skipping) { if (name === skipping.name && --skipping.depth === 0) skipping = undefined; continue; }
      closeTag(name);
      continue;
    }
    TAG.lastIndex = at;
    const open = TAG.exec(html);
    if (!open) { if (!skipping) write("<"); at++; continue; }
    at = TAG.lastIndex;
    const name = open[1]!.toLowerCase();
    const selfClosing = open[3] === "/" || VOID.has(name);
    if (RAW.has(name) && !selfClosing) {
      // Their insides aren't markup: straight past the closing tag.
      const end = lower.indexOf(`</${name}`, at);
      const inside = end === -1 ? html.slice(at) : html.slice(at, end);
      const after = end === -1 ? -1 : html.indexOf(">", end);
      at = after === -1 ? html.length : after + 1;
      if (!skipping && name === "textarea") write(decodeEntities(inside));
      continue;
    }
    if (skipping) { if (name === skipping.name && !selfClosing) skipping.depth++; continue; }
    const attrs = attributes(open[2] ?? "");
    // MathML says itself best in its TeX, when it carries it.
    if (name === "math" && attrs.alttext) write(` $${attrs.alttext.trim()}$ `);
    if (SKIP.has(name) || (hidden(attrs) && !selfClosing)) { if (!selfClosing) skipping = { name, depth: 1 }; continue; }
    openTag(name, attrs, selfClosing);
  }
  while (links.length) closeTag("a");
  return out.toString().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  function openTag(name: string, attrs: Attributes, selfClosing: boolean) {
    const level = /^h([1-6])$/.exec(name);
    if (level) { blank(); out.push(`${"#".repeat(Number(level[1]))} `); heading = true; return; }
    switch (name) {
      case "br": if (pre) out.push("\n"); else if (heading) write(" "); else if (!opening()) { out.trimEnd(); out.push("\n"); } return;
      case "hr": blank(); out.push("---"); blank(); return;
      // In a list item, a paragraph is a line: the list stays tight.
      case "p": if (lists.length) newline(); else blank(); return;
      case "pre": blank(); out.push(`\`\`\`${language(attrs)}\n`); pre++; fresh = true; return;
      case "code": {
        if (!pre) { codes.push(out.length); out.push("`"); return; }
        // <pre><code class="language-c">: the fence names its language.
        const named = language(attrs);
        if (named && out.endsWith("```\n")) { out.cut(out.length - 1); out.push(`${named}\n`); }
        return;
      }
      case "sup": case "sub": scripts.push({ mark: name === "sup" ? "^" : "_", start: out.length }); return;
      case "ul": case "ol":
        if (lists.length) newline(); else blank();
        lists.push({ ordered: name === "ol", index: (Number.parseInt(attrs.start ?? "1", 10) || 1) - 1 });
        return;
      case "li": {
        newline();
        const list = lists.at(-1);
        out.push(`${"  ".repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${++list.index}. ` : "- "}`);
        return;
      }
      case "dt": newline(); return;
      case "dd": newline(); out.push("  "); return;
      case "blockquote": blank(); quotes.push(out.length); return;
      case "table": blank(); return;
      case "tr": newline(); cells.push(0); return;
      case "td": case "th": {
        const count = cells.length ? cells[cells.length - 1]! : 0;
        if (cells.length) cells[cells.length - 1] = count + 1;
        if (count > 0) { out.trimEnd(); out.push(" | "); }
        return;
      }
      case "a": if (!selfClosing) links.push({ href: absolute(attrs.href, base), start: out.length }); return;
      case "img": {
        const alt = (attrs.alt ?? "").replace(/\s+/g, " ").trim();
        // No words, or an icon's one or two characters: nothing to read.
        if (alt.replace(/[^\p{L}\p{N}]/gu, "").length < 3 || attrs.width === "1") return;
        // A formula drawn as a picture: its TeX is the part worth reading.
        if (/\\[a-zA-Z]+|^\$|displaystyle/.test(alt) || /\b(math|tex|latex)/i.test(attrs.class ?? "")) { write(` ${alt.startsWith("$") ? alt : `$${alt}$`} `); return; }
        const src = absolute(attrs.src ?? attrs["data-src"], base);
        if (src) write(` ![${alt.replace(/[[\]]/g, "")}](${src}) `);
        return;
      }
      default:
        if (BLOCK.has(name)) newline();
    }
  }

  function closeTag(name: string) {
    if (/^h[1-6]$/.test(name)) { heading = false; blank(); return; }
    switch (name) {
      case "p": if (lists.length) newline(); else blank(); return;
      case "pre":
        if (!pre) return;
        pre--; fresh = false;
        if (!out.endsWith("\n")) out.push("\n");
        out.push("```"); blank();
        return;
      case "code": {
        if (pre) return;
        const start = codes.pop();
        if (start === undefined) return;
        // An empty <code></code> leaves nothing behind.
        if (out.length === start + 1) out.cut(start); else out.push("`");
        return;
      }
      case "sup": case "sub": {
        const script = scripts.pop();
        if (!script) return;
        const inside = out.cut(script.start).trim();
        if (!inside) return;
        if (out.endsWith(" ")) out.cut(out.length - 1);
        out.push(/^[\w.+-]{1,3}$/.test(inside) && !/^[+-]/.test(inside) ? `${script.mark}${inside}` : `${script.mark}(${inside})`);
        return;
      }
      case "ul": case "ol": lists.pop(); if (lists.length) newline(); else blank(); return;
      case "li": case "dt": case "dd": newline(); return;
      case "tr": cells.pop(); newline(); return;
      case "table": cells.length = 0; blank(); return;
      case "blockquote": {
        const start = quotes.pop();
        if (start === undefined) return;
        out.trimEnd();
        const quoted = out.cut(start).trim().split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
        out.push(quoted);
        blank();
        return;
      }
      case "a": {
        const link = links.pop();
        if (!link) return;
        const inside = out.cut(link.start);
        const text = inside.replace(/\s+/g, " ").trim();
        if (!pre && link.href && text && text.length <= 200 && text !== link.href && !text.startsWith("![") && !linked.has(link.href)) {
          linked.add(link.href);
          const lead = /^\s*/.exec(inside)?.[0] ?? "";
          out.push(`${lead.includes("\n") ? "\n" : lead ? " " : ""}[${text.replace(/[[\]]/g, "")}](${link.href})`);
        } else out.push(inside);
        return;
      }
      default:
        if (BLOCK.has(name)) newline();
    }
  }
}

/** The language a code block's class names ("language-c", "lang-js"). */
function language(attrs: Attributes): string {
  return /(?:^|\s)(?:lang|language|highlight-source)-([\w+#-]+)/.exec(attrs.class ?? "")?.[1] ?? attrs["data-lang"]?.replace(/[^\w+#-]/g, "") ?? "";
}

/** The page's own words for itself: <title> (or og:title) and its description. */
function heading(html: string): { title?: string; description?: string } {
  const clean = (text: string | undefined) => (text ? decodeEntities(text).replace(/\s+/g, " ").trim() || undefined : undefined);
  const meta = (key: string) => {
    for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
      const attrs = attributes(match[1] ?? "");
      if ((attrs.name ?? attrs.property ?? "").toLowerCase() === key) return attrs.content;
    }
    return undefined;
  };
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]) ?? clean(meta("og:title"));
  const description = clean(meta("description")) ?? clean(meta("og:description"));
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

/** The page's main part, when it marks one: its <main>, or its only <article>. */
function mainPart(html: string): string | undefined {
  const lower = html.toLowerCase();
  const main = /<main\b[^>]*>/i.exec(html);
  if (main) { const end = lower.lastIndexOf("</main>"); if (end > main.index) return html.slice(main.index, end + 7); }
  const articles = [...html.matchAll(/<article\b[^>]*>/gi)];
  if (articles.length === 1) { const end = lower.lastIndexOf("</article>"); if (end > articles[0]!.index) return html.slice(articles[0]!.index, end + 10); }
  return undefined;
}

export function readHtml(html: string, base: string): PageText {
  const head = heading(html);
  // <base href> moves where the page's links point.
  const baseHref = /<base\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  const from = baseHref ? absolute(decodeEntities(baseHref), base) ?? base : base;
  const main = mainPart(html);
  let text = main ? htmlToText(main, from) : "";
  // A main part with hardly anything in it (a page that marks it oddly): the whole page instead.
  if (text.length < 300) { const whole = htmlToText(html, from); if (whole.length > text.length) text = whole; }
  const scripted = text.length < 250 && /<script\b/i.test(html);
  return { ...head, text, scripted };
}
