import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { baseName, downloadBlob } from '../shared/image';
import Tree from './Tree';
import { formatBytes, highlight, JsonParseError, lineCol, parseJson, printJson, sortNode, stats, type JsonNode } from './json';
import './json-tools.css';

type View = 'pretty' | 'minified' | 'tree';
type Indent = '2' | '4' | 'tab';

const INDENTS: Record<Indent, string> = { '2': '  ', '4': '    ', tab: '\t' };
const HIGHLIGHT_LIMIT = 400_000; // characters; bigger outputs are shown as plain text
const TREE_BUDGET = 2500; // rows "Expand all" may open at once

const SAMPLE = `{"name":"Ecy","site":"https://ecyzhi.com","tools":[{"slug":"circle-crop","category":"Media","live":true},{"slug":"json","category":"Developer","live":true,"features":["format","validate","minify","tree"]}],"stats":{"visits":12345678901234567890,"rating":4.9,"offline":true,"lastError":null}}`;

const VIEWS: { value: View; label: string }[] = [
  { value: 'pretty', label: 'Pretty' },
  { value: 'minified', label: 'Minified' },
  { value: 'tree', label: 'Tree' },
];

type Result =
  | { kind: 'empty' }
  | { kind: 'ok'; root: JsonNode }
  | { kind: 'error'; message: string; pos: number; line: number; col: number; lineText: string };

function analyse(text: string): Result {
  if (!text.trim()) return { kind: 'empty' };
  try {
    return { kind: 'ok', root: parseJson(text) };
  } catch (e) {
    if (e instanceof JsonParseError) return { kind: 'error', message: e.message, pos: e.pos, ...lineCol(text, e.pos) };
    return { kind: 'error', message: 'Could not read this JSON.', pos: 0, line: 1, col: 1, lineText: '' };
  }
}

const byteLength = (s: string) => new Blob([s]).size;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or no permission: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Deepest tree level that "Expand all" can open without rendering more than the budget. */
function safeOpenDepth(root: JsonNode) {
  const perDepth: number[] = [];
  const walk = (n: JsonNode, d: number) => {
    perDepth[d] = (perDepth[d] ?? 0) + 1;
    if (n.type === 'object') n.entries.slice(0, 100).forEach((e) => walk(e.value, d + 1));
    else if (n.type === 'array') n.items.slice(0, 100).forEach((v) => walk(v, d + 1));
  };
  walk(root, 0);
  let rows = 0;
  for (let d = 0; d < perDepth.length; d++) {
    rows += perDepth[d];
    if (rows > TREE_BUDGET) return Math.max(1, d);
  }
  return perDepth.length;
}

export default function JsonTools() {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('data');
  const [view, setView] = useState<View>('pretty');
  const [indent, setIndent] = useState<Indent>('2');
  const [sortKeys, setSortKeys] = useState(false);
  const [selected, setSelected] = useState<{ path: string; node: JsonNode } | null>(null);
  const [tree, setTree] = useState({ key: 0, openDepth: 2 });
  const [flash, setFlash] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [canPaste, setCanPaste] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const flashTimer = useRef<number>(0);

  const deferred = useDeferredValue(text);
  const result = useMemo(() => analyse(deferred), [deferred]);
  const root = result.kind === 'ok' ? result.root : null;
  const shownRoot = useMemo(() => (root && sortKeys ? sortNode(root) : root), [root, sortKeys]);
  const info = useMemo(() => (root ? stats(root) : null), [root]);
  const pretty = useMemo(() => (root ? printJson(root, INDENTS[indent], sortKeys) : ''), [root, indent, sortKeys]);
  const minified = useMemo(() => (root && view === 'minified' ? printJson(root, '', sortKeys) : ''), [root, sortKeys, view]);
  const output = view === 'minified' ? minified : pretty;
  const html = useMemo(() => (view !== 'tree' && output.length <= HIGHLIGHT_LIMIT ? highlight(output) : null), [output, view]);
  const inBytes = useMemo(() => byteLength(deferred), [deferred]);
  const outBytes = useMemo(() => (output ? byteLength(output) : 0), [output]);

  useEffect(() => {
    setCanPaste(typeof navigator !== 'undefined' && !!navigator.clipboard?.readText);
    return () => window.clearTimeout(flashTimer.current);
  }, []);

  // A new document resets the tree's selection and expansion.
  useEffect(() => {
    setSelected(null);
    setTree((t) => ({ key: t.key + 1, openDepth: 2 }));
  }, [root]);

  const say = useCallback((msg: string) => {
    setFlash(msg);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1600);
  }, []);

  const loadFile = useCallback(async (file: File) => {
    try {
      setText(await file.text());
      setFileName(baseName(file.name) || 'data');
    } catch {
      say('Could not read that file');
    }
  }, [say]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  };

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setText(t);
    } catch {
      say('Paste was blocked. Long-press the box to paste.');
    }
  };

  const jumpToError = () => {
    const ta = inputRef.current;
    if (!ta || result.kind !== 'error') return;
    ta.focus({ preventScroll: true });
    ta.scrollIntoView({ block: 'center' });
    ta.setSelectionRange(result.pos, Math.min(result.pos + 1, text.length));
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (result.line - 4) * lh);
  };

  const copyOutput = async () => {
    const t = view === 'tree' ? pretty : output;
    say((await copyText(t)) ? 'Copied' : 'Copy failed');
  };

  const download = () => {
    const t = view === 'minified' ? minified : pretty;
    downloadBlob(new Blob([t + (view === 'minified' ? '' : '\n')], { type: 'application/json' }), `${fileName}${view === 'minified' ? '.min' : ''}.json`);
  };

  const replaceInput = () => {
    const t = view === 'minified' ? minified : pretty;
    if (t) setText(t);
  };

  const valid = result.kind === 'ok';

  return (
    <div className="jt">
      <section
        className={`jt-card jt-in${dragOver ? ' is-over' : ''}`}
        aria-label="Input"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="jt-bar">
          <span className="jt-title mono">input</span>
          <div className="jt-actions">
            {canPaste && (
              <button type="button" className="jt-btn" onClick={paste}>
                Paste
              </button>
            )}
            <button type="button" className="jt-btn" onClick={() => fileRef.current?.click()}>
              Open file
            </button>
            <button
              type="button"
              className="jt-btn"
              onClick={() => {
                setText(SAMPLE);
                setFileName('sample');
              }}
            >
              Sample
            </button>
            <button
              type="button"
              className="jt-btn"
              disabled={!text}
              onClick={() => {
                setText('');
                setFileName('data');
                inputRef.current?.focus();
              }}
            >
              Clear
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json,text/plain,.txt,.geojson"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <textarea
          ref={inputRef}
          className="jt-text mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Paste or type JSON here, or drop a .json file.\n\n{"hello": "world"}'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-label="JSON input"
          aria-invalid={result.kind === 'error'}
          aria-describedby="jt-status"
        />
        <div id="jt-status" className={`jt-status${result.kind === 'error' ? ' is-error' : ''}`} aria-live="polite">
          {result.kind === 'empty' && <span className="jt-dim">Waiting for JSON</span>}
          {result.kind === 'ok' && info && (
            <>
              <span className="jt-ok">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12.5 10 17 19 7" />
                </svg>
                Valid JSON
              </span>
              <span className="jt-dim mono">
                {formatBytes(inBytes)} · {info.keys} {info.keys === 1 ? 'key' : 'keys'} · depth {info.depth}
              </span>
            </>
          )}
          {result.kind === 'error' && (
            <div className="jt-err">
              <div className="jt-err-head">
                <span>
                  <strong className="mono">
                    Line {result.line}, col {result.col}
                  </strong>{' '}
                  {result.message}
                </span>
                <button type="button" className="jt-btn" onClick={jumpToError}>
                  Show me
                </button>
              </div>
              {result.lineText && (
                <pre className="jt-err-line mono" aria-hidden="true">
                  {errorSnippet(result.lineText, result.col)}
                </pre>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="jt-card jt-out" aria-label="Output">
        <div className="jt-bar">
          <div className="jt-seg" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.value} type="button" aria-pressed={view === v.value} onClick={() => setView(v.value)}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="jt-actions">
            {view === 'tree' && (
              <>
                <button type="button" className="jt-btn" disabled={!shownRoot} onClick={() => shownRoot && setTree((t) => ({ key: t.key + 1, openDepth: safeOpenDepth(shownRoot) }))}>
                  Expand all
                </button>
                <button type="button" className="jt-btn" disabled={!shownRoot} onClick={() => setTree((t) => ({ key: t.key + 1, openDepth: 1 }))}>
                  Collapse all
                </button>
              </>
            )}
            {view === 'pretty' && (
              <label className="jt-select">
                <span className="visually-hidden">Indent</span>
                <select value={indent} onChange={(e) => setIndent(e.target.value as Indent)} aria-label="Indent">
                  <option value="2">2 spaces</option>
                  <option value="4">4 spaces</option>
                  <option value="tab">Tabs</option>
                </select>
              </label>
            )}
            <button type="button" className="jt-btn" aria-pressed={sortKeys} onClick={() => setSortKeys((s) => !s)}>
              Sort keys
            </button>
          </div>
        </div>

        <div className="jt-view">
          {!valid ? (
            <div className="jt-empty">
              {result.kind === 'error' ? (
                <>
                  <p className="jt-empty-title">Not valid JSON yet</p>
                  <p>Fix the problem on line {result.line} and the output appears here.</p>
                </>
              ) : (
                <>
                  <p className="jt-empty-title">Nothing to show yet</p>
                  <p>
                    Paste JSON into the input, open a file, or try the <button type="button" className="jt-link" onClick={() => { setText(SAMPLE); setFileName('sample'); }}>sample</button>.
                  </p>
                </>
              )}
            </div>
          ) : view === 'tree' && shownRoot ? (
            <div className="jt-tree-wrap">
              <div className="jt-scroll">
                <Tree
                  key={tree.key}
                  root={shownRoot}
                  openDepth={tree.openDepth}
                  selected={selected?.path ?? null}
                  onSelect={(path, node) => setSelected({ path, node })}
                />
              </div>
              <div className="jt-path">
                {selected ? (
                  <>
                    <span className="jt-dim">Copy</span>
                    <code className="jt-path-text mono" title={selected.path}>
                      {selected.path}
                    </code>
                    <button type="button" className="jt-btn" onClick={async () => say((await copyText(selected.path)) ? 'Path copied' : 'Copy failed')}>
                      Path
                    </button>
                    <button
                      type="button"
                      className="jt-btn"
                      onClick={async () => say((await copyText(printJson(selected.node, INDENTS[indent]))) ? 'Value copied' : 'Copy failed')}
                    >
                      Value
                    </button>
                  </>
                ) : (
                  <span className="jt-dim">Tap a row to copy its path or value.</span>
                )}
              </div>
            </div>
          ) : html !== null ? (
            <pre className={`jt-code mono${view === 'minified' ? ' is-wrap' : ''}`} tabIndex={0} aria-label="Output JSON" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className={`jt-code mono${view === 'minified' ? ' is-wrap' : ''}`} tabIndex={0} aria-label="Output JSON">
              {output}
            </pre>
          )}
        </div>

        <div className="jt-foot">
          <span className="jt-dim mono">
            {valid && view !== 'tree' ? `${formatBytes(outBytes)}${inBytes ? ` · ${sizeChange(inBytes, outBytes)}` : ''}` : ''}
          </span>
          <div className="jt-actions">
            <button type="button" className="jt-btn" disabled={!valid || view === 'tree'} onClick={replaceInput}>
              Replace input
            </button>
            <button type="button" className="jt-btn" disabled={!valid} onClick={download}>
              Download
            </button>
            <button type="button" className="btn btn-primary jt-copy" disabled={!valid} onClick={copyOutput}>
              Copy
            </button>
          </div>
        </div>
      </section>

      <div className={`jt-toast${flash ? ' is-on' : ''}`} role="status" aria-live="polite">
        {flash}
      </div>
    </div>
  );
}

function sizeChange(from: number, to: number) {
  if (from === to) return 'same size';
  const pct = Math.round(((to - from) / from) * 100);
  return pct === 0 ? 'about the same size' : `${pct > 0 ? '+' : ''}${pct}% vs input`;
}

/** The error's line, trimmed around the column, with a caret under the problem. */
function errorSnippet(line: string, col: number) {
  const max = 60;
  let start = 0;
  if (line.length > max) start = Math.max(0, Math.min(col - 1 - max / 2, line.length - max));
  const shown = line.slice(start, start + max).replace(/\t/g, ' ');
  const prefix = start > 0 ? '…' : '';
  const suffix = start + max < line.length ? '…' : '';
  const caret = ' '.repeat(prefix.length + Math.max(0, col - 1 - start)) + '^';
  return `${prefix}${shown}${suffix}\n${caret}`;
}
