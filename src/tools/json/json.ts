/**
 * A small JSON parser and printer.
 *
 * It exists instead of JSON.parse/JSON.stringify for three reasons:
 * - errors carry a position in every browser (Safari's JSON.parse gives none),
 *   with messages that say what went wrong in plain words;
 * - numbers and strings keep their source text, so big integers like
 *   12345678901234567890 and escapes like é survive formatting unchanged;
 * - duplicate keys are kept, so formatting never drops data silently.
 */

export type JsonNode =
  | { type: 'object'; entries: JsonEntry[] }
  | { type: 'array'; items: JsonNode[] }
  | { type: 'string'; value: string; raw: string }
  | { type: 'number'; raw: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' };

export interface JsonEntry {
  key: string; // decoded
  raw: string; // as written, quotes included
  value: JsonNode;
}

export class JsonParseError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const HEX = /^[0-9a-fA-F]{4}$/;

export function parseJson(text: string): JsonNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // skip a byte order mark

  const fail = (message: string, at = i): never => {
    throw new JsonParseError(message, at);
  };

  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++;
      else if (c === 47 && (text[i + 1] === '/' || text[i + 1] === '*')) fail('Comments are not allowed in JSON.');
      else return;
    }
  };

  const describe = (at: number) => {
    if (at >= text.length) return 'the end of the input';
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(at, at + 40));
    return word ? `“${word[0]}”` : `“${text[at]}”`;
  };

  const str = (): { value: string; raw: string } => {
    const start = i;
    i++; // opening quote
    let escaped = false;
    for (;;) {
      if (i >= text.length) fail('This string never ends. Add the closing ".', start);
      const c = text.charCodeAt(i);
      if (c === 34) break;
      if (c < 0x20) {
        fail(c === 10 ? 'Line breaks inside a string must be written as \\n.' : 'Control characters inside a string must be escaped.');
      }
      if (c === 92) {
        escaped = true;
        const e = text[i + 1];
        if (e === 'u') {
          if (!HEX.test(text.slice(i + 2, i + 6))) fail('\\u must be followed by four hex digits.');
          i += 6;
          continue;
        }
        if (e === undefined || !ESCAPES.has(e)) fail(`“\\${e ?? ''}” is not a valid escape.`);
        i += 2;
        continue;
      }
      i++;
    }
    i++; // closing quote
    const raw = text.slice(start, i);
    return { value: escaped ? (JSON.parse(raw) as string) : raw.slice(1, -1), raw };
  };

  const value = (): JsonNode => {
    ws();
    const c = text[i];
    if (c === '{') return obj();
    if (c === '[') return arr();
    if (c === '"') return { type: 'string', ...str() };
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m || m[0] === '-') fail('This number is not valid JSON.');
      const end = i + m![0].length;
      if (/[\w.]/.test(text[end] ?? '')) fail('This number is not valid JSON.', i);
      const raw = m![0];
      i = end;
      return { type: 'number', raw };
    }
    if (text.startsWith('true', i)) return (i += 4), { type: 'boolean', value: true };
    if (text.startsWith('false', i)) return (i += 5), { type: 'boolean', value: false };
    if (text.startsWith('null', i)) return (i += 4), { type: 'null' };
    if (c === "'") fail('Strings must use double quotes, not single quotes.');
    if (c === undefined) fail('The JSON ends too early. A value is missing.');
    if (/^(?:NaN|Infinity|undefined)\b/.test(text.slice(i, i + 9))) fail(`${describe(i)} is not a JSON value.`);
    return fail(`Expected a value, found ${describe(i)}.`);
  };

  const obj = (): JsonNode => {
    const open = i;
    i++;
    const entries: JsonEntry[] = [];
    ws();
    if (text[i] === '}') return i++, { type: 'object', entries };
    for (;;) {
      ws();
      if (text[i] === '"') {
        const k = str();
        ws();
        if (text[i] !== ':') fail(`Expected “:” after the property name, found ${describe(i)}.`);
        i++;
        entries.push({ key: k.value, raw: k.raw, value: value() });
      } else if (text[i] === "'") {
        fail('Property names must use double quotes, not single quotes.');
      } else if (i >= text.length) {
        fail('This object is never closed. Add the closing }.', open);
      } else {
        fail(`Property names must be in double quotes. Found ${describe(i)}.`);
      }
      ws();
      if (text[i] === ',') {
        const comma = i;
        i++;
        ws();
        if (text[i] === '}') fail('Remove the comma before }. JSON does not allow trailing commas.', comma);
        continue;
      }
      if (text[i] === '}') return i++, { type: 'object', entries };
      if (i >= text.length) fail('This object is never closed. Add the closing }.', open);
      fail(`Expected “,” or “}” after a property, found ${describe(i)}.`);
    }
  };

  const arr = (): JsonNode => {
    const open = i;
    i++;
    const items: JsonNode[] = [];
    ws();
    if (text[i] === ']') return i++, { type: 'array', items };
    for (;;) {
      items.push(value());
      ws();
      if (text[i] === ',') {
        const comma = i;
        i++;
        ws();
        if (text[i] === ']') fail('Remove the comma before ]. JSON does not allow trailing commas.', comma);
        continue;
      }
      if (text[i] === ']') return i++, { type: 'array', items };
      if (i >= text.length) fail('This array is never closed. Add the closing ].', open);
      fail(`Expected “,” or “]” after an item, found ${describe(i)}.`);
    }
  };

  try {
    ws();
    if (i >= text.length) fail('There is no JSON here yet.');
    const root = value();
    ws();
    if (i < text.length) fail(`Unexpected ${describe(i)} after the end of the JSON.`);
    return root;
  } catch (e) {
    if (e instanceof RangeError) throw new JsonParseError('This JSON is nested too deeply to read.', 0);
    throw e;
  }
}

/** 1-based line and column of a character offset. */
export function lineCol(text: string, pos: number) {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < pos && k < text.length; k++) {
    if (text.charCodeAt(k) === 10) {
      line++;
      lineStart = k + 1;
    }
  }
  let lineEnd = text.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = text.length;
  return { line, col: pos - lineStart + 1, lineText: text.slice(lineStart, lineEnd).replace(/\r$/, '') };
}

const byKey = (a: JsonEntry, b: JsonEntry) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Prints a node. An empty indent gives minified output. */
export function printJson(root: JsonNode, indent: string, sortKeys = false): string {
  const out: string[] = [];
  const nl = indent ? '\n' : '';
  const colon = indent ? ': ' : ':';
  const write = (n: JsonNode, pad: string) => {
    switch (n.type) {
      case 'object': {
        if (!n.entries.length) return void out.push('{}');
        const inner = pad + indent;
        const entries = sortKeys ? [...n.entries].sort(byKey) : n.entries;
        out.push('{', nl);
        entries.forEach((e, k) => {
          out.push(inner, e.raw, colon);
          write(e.value, inner);
          out.push(k < entries.length - 1 ? ',' : '', nl);
        });
        return void out.push(pad, '}');
      }
      case 'array': {
        if (!n.items.length) return void out.push('[]');
        const inner = pad + indent;
        out.push('[', nl);
        n.items.forEach((v, k) => {
          out.push(inner);
          write(v, inner);
          out.push(k < n.items.length - 1 ? ',' : '', nl);
        });
        return void out.push(pad, ']');
      }
      case 'string':
        return void out.push(n.raw);
      case 'number':
        return void out.push(n.raw);
      case 'boolean':
        return void out.push(n.value ? 'true' : 'false');
      case 'null':
        return void out.push('null');
    }
  };
  write(root, '');
  return out.join('');
}

export function sortNode(n: JsonNode): JsonNode {
  if (n.type === 'object') return { type: 'object', entries: [...n.entries].sort(byKey).map((e) => ({ ...e, value: sortNode(e.value) })) };
  if (n.type === 'array') return { type: 'array', items: n.items.map(sortNode) };
  return n;
}

export function stats(root: JsonNode) {
  let keys = 0;
  let values = 0;
  let depth = 0;
  const walk = (n: JsonNode, d: number) => {
    values++;
    if (d > depth) depth = d;
    if (n.type === 'object') {
      keys += n.entries.length;
      for (const e of n.entries) walk(e.value, d + 1);
    } else if (n.type === 'array') {
      for (const v of n.items) walk(v, d + 1);
    }
  };
  walk(root, 0);
  return { keys, values, depth };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TOKEN = /("(?:[^"\\\n]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

/** HTML with token classes for printed JSON. Input must come from printJson. */
export function highlight(json: string): string {
  return json.replace(TOKEN, (m, s: string, colon: string, num: string, lit: string, punct: string) => {
    if (s) return colon ? `<span class="jt-k">${escapeHtml(s)}</span><span class="jt-p">${colon}</span>` : `<span class="jt-s">${escapeHtml(s)}</span>`;
    if (num) return `<span class="jt-n">${num}</span>`;
    if (lit) return `<span class="jt-${lit === 'null' ? 'z' : 'b'}">${lit}</span>`;
    if (punct) return `<span class="jt-p">${punct}</span>`;
    return escapeHtml(m);
  });
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** JavaScript-style path segment, e.g. .name, ["first name"], [3]. */
export function pathSegment(key: string | number): string {
  if (typeof key === 'number') return `[${key}]`;
  return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
