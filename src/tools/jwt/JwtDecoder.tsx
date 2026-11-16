import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CLAIM_NAMES,
  SAMPLE_SECRET,
  TIME_CLAIMS,
  algInfo,
  makeSample,
  parseJwt,
  relative,
  timeStatus,
  verifyJwt,
  type Json,
  type JsonObject,
  type VerifyResult,
} from './jwt';
import './jwt.css';

// ---------- Small helpers ----------

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Safari / insecure origins: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 1500);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <button type="button" className="jwt-mini" onClick={async () => setState((await copyText(text)) ? 'done' : 'fail')}>
      {state === 'done' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Pretty JSON with light syntax colouring, built as React nodes (no innerHTML). */
function JsonView({ value }: { value: Json }) {
  const text = JSON.stringify(value, null, 2);
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) nodes.push(<span key={i++} className="j-p">{text.slice(last, at)}</span>);
    if (m[1] && m[2]) {
      nodes.push(<span key={i++} className="j-k">{m[1]}</span>);
      nodes.push(<span key={i++} className="j-p">{m[2]}</span>);
    } else if (m[1]) nodes.push(<span key={i++} className="j-s">{m[1]}</span>);
    else nodes.push(<span key={i++} className="j-n">{m[0]}</span>);
    last = at + m[0].length;
  }
  if (last < text.length) nodes.push(<span key={i++} className="j-p">{text.slice(last)}</span>);
  return <pre className="jwt-json mono">{nodes}</pre>;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
function fmtLocal(sec: number) {
  const d = new Date(sec * 1000);
  return isNaN(d.getTime()) ? String(sec) : dateFmt.format(d);
}
function fmtUtc(sec: number) {
  const d = new Date(sec * 1000);
  return isNaN(d.getTime()) ? '' : d.toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC').replace(/Z$/, ' UTC');
}

function ClaimValue({ name, value, now }: { name: string; value: Json; now: number }) {
  if (TIME_CLAIMS.has(name) && typeof value === 'number') {
    return (
      <div className="jwt-time">
        <span>{fmtLocal(value)}</span>
        <span className="jwt-sub mono">
          {relative(value, now)} · {value}
        </span>
        <span className="jwt-sub mono">{fmtUtc(value)}</span>
      </div>
    );
  }
  if (name === 'scope' && typeof value === 'string' && value.includes(' ')) value = value.split(/\s+/);
  if (Array.isArray(value) && value.every((v) => typeof v !== 'object' || v === null)) {
    return (
      <div className="jwt-chips">
        {value.length === 0 ? <span className="jwt-sub">empty list</span> : value.map((v, i) => <span key={i} className="jwt-chip mono">{String(v)}</span>)}
      </div>
    );
  }
  if (value !== null && typeof value === 'object') return <JsonView value={value} />;
  if (typeof value === 'string') return <span className="jwt-str">{value}</span>;
  return <span className="mono">{String(value)}</span>;
}

function ClaimsTable({ obj, now }: { obj: JsonObject; now: number }) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return <p className="jwt-sub">No claims.</p>;
  return (
    <dl className="jwt-claims">
      {keys.map((k) => (
        <Fragment key={k}>
          <dt>
            <span className="mono">{k}</span>
            {CLAIM_NAMES[k] && <span className="jwt-sub">{CLAIM_NAMES[k]}</span>}
          </dt>
          <dd>
            <ClaimValue name={k} value={obj[k]} now={now} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Panel({ title, raw, actions, children }: { title: string; raw?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="jwt-panel card">
      <header className="jwt-panel-head">
        <h3 className="mono">{title}</h3>
        <div className="jwt-actions">
          {actions}
          {raw !== undefined && <CopyButton text={raw} />}
        </div>
      </header>
      {children}
    </section>
  );
}

// ---------- Main editor ----------

type View = 'json' | 'claims';

export default function JwtDecoder() {
  const [input, setInput] = useState('');
  const [view, setView] = useState<View>('json');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [secret, setSecret] = useState('');
  const [secretEnc, setSecretEnc] = useState<'utf8' | 'base64'>('utf8');
  const [publicKey, setPublicKey] = useState('');
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [canPaste, setCanPaste] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const parsed = useMemo(() => parseJwt(input), [input]);
  const jwt = parsed.ok ? parsed.jwt : null;
  const header = jwt?.header.value;
  const payload = jwt?.payload.value;
  const alg = header?.alg;
  const info = algInfo(alg);
  const status = timeStatus(payload, now);
  const hasTime = status.state !== 'none';

  useEffect(() => {
    setCanPaste(typeof navigator !== 'undefined' && !!navigator.clipboard && 'readText' in navigator.clipboard);
  }, []);

  // Tick once a second only while a time claim is on screen.
  useEffect(() => {
    if (!hasTime) return;
    setNow(Math.floor(Date.now() / 1000));
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [hasTime]);

  // Check the signature whenever the token or key changes (debounced).
  const keyText = info?.family === 'HS' ? secret : publicKey;
  useEffect(() => {
    setVerify(null);
    if (!parsed.ok || jwt?.kind !== 'jws' || !info || !keyText.trim()) {
      setChecking(false);
      return;
    }
    let live = true;
    setChecking(true);
    const t = window.setTimeout(async () => {
      const r = await verifyJwt(parsed.token, alg, header?.kid, keyText, secretEnc);
      if (live) {
        setVerify(r);
        setChecking(false);
      }
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [parsed.ok && parsed.token, keyText, secretEnc, alg]);

  async function loadSample() {
    const tok = await makeSample();
    setInput(tok);
    setSecret(SAMPLE_SECRET);
    setSecretEnc('utf8');
  }

  async function paste() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setInput(t);
    } catch {
      taRef.current?.focus();
    }
  }

  function clear() {
    setInput('');
    setSecret('');
    setPublicKey('');
    taRef.current?.focus();
  }

  // Coloured mirror of the token behind the textarea.
  const mirror = useMemo(() => {
    const segs = input.split('.');
    const cls = segs.length === 5 ? ['h', 'p', 'p', 'p', 's'] : ['h', 'p', 's'];
    return segs.map((s, i) => (
      <Fragment key={i}>
        {i > 0 && <span className="t-dot">.</span>}
        <span className={`t-${cls[i] ?? 'x'}`}>{s}</span>
      </Fragment>
    ));
  }, [input]);

  return (
    <div className="jwt">
      <div className="jwt-left">
        <section className="jwt-input card">
          <header className="jwt-panel-head">
            <label htmlFor="jwt-token" className="mono">
              Encoded token
            </label>
            <div className="jwt-actions">
              {canPaste && (
                <button type="button" className="jwt-mini" onClick={paste}>
                  Paste
                </button>
              )}
              <button type="button" className="jwt-mini" onClick={loadSample}>
                Sample
              </button>
              <button type="button" className="jwt-mini" onClick={clear} disabled={!input}>
                Clear
              </button>
            </div>
          </header>
          <div className="jwt-editor mono">
            <div className="jwt-mirror" aria-hidden="true">
              {mirror}
              {'\u200b'}
            </div>
            <textarea
              id="jwt-token"
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Paste a JWT here: eyJhbGciOi…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              rows={6}
            />
          </div>
          <div className="jwt-legend mono" aria-hidden="true">
            <span className="t-h">header</span>
            <span className="t-dot">.</span>
            <span className="t-p">payload</span>
            <span className="t-dot">.</span>
            <span className="t-s">signature</span>
          </div>
        </section>

        {parsed.ok && jwt?.kind === 'jws' && (
          <section className="jwt-panel card">
            <header className="jwt-panel-head">
              <h3 className="mono">Signature</h3>
              {typeof alg === 'string' && <span className="jwt-chip mono">{alg}</span>}
            </header>
            {alg === 'none' ? (
              <p className="jwt-note warn">This token isn’t signed (alg: none). Anyone can change it, so don’t trust its claims.</p>
            ) : !info ? (
              <p className="jwt-note">This tool can’t check {typeof alg === 'string' ? `"${alg}"` : 'this'} signatures. The header and payload are still decoded.</p>
            ) : (
              <>
                {info.family === 'HS' ? (
                  <div className="jwt-field">
                    <div className="jwt-row">
                      <label htmlFor="jwt-secret" className="jwt-label">
                        Secret
                      </label>
                      <div className="jwt-seg" role="group" aria-label="Secret encoding">
                        <button type="button" aria-pressed={secretEnc === 'utf8'} onClick={() => setSecretEnc('utf8')}>
                          Text
                        </button>
                        <button type="button" aria-pressed={secretEnc === 'base64'} onClick={() => setSecretEnc('base64')}>
                          Base64
                        </button>
                      </div>
                    </div>
                    <input
                      id="jwt-secret"
                      className="jwt-text mono"
                      type="text"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder="The shared secret"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                    />
                  </div>
                ) : (
                  <div className="jwt-field">
                    <label htmlFor="jwt-key" className="jwt-label">
                      Public key (PEM or JWK)
                    </label>
                    <textarea
                      id="jwt-key"
                      className="jwt-text mono"
                      value={publicKey}
                      onChange={(e) => setPublicKey(e.target.value)}
                      placeholder={'-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----'}
                      rows={5}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                    />
                  </div>
                )}
                <p className={`jwt-verify ${verify?.state ?? 'idle'}`} role="status">
                  {checking
                    ? 'Checking…'
                    : !verify
                      ? info.family === 'HS'
                        ? 'Enter the secret to check the signature.'
                        : 'Paste the public key to check the signature.'
                      : verify.state === 'valid'
                        ? 'Signature verified'
                        : verify.state === 'invalid'
                          ? 'Signature doesn’t match'
                          : verify.message}
                </p>
              </>
            )}
          </section>
        )}
      </div>

      <div className="jwt-right">
        {!input.trim() ? (
          <div className="jwt-empty card">
            <p className="dz-title">Paste a token to decode it</p>
            <p className="jwt-sub">The header and payload show up here, with readable dates and how long until it expires.</p>
            <button type="button" className="btn btn-ghost" onClick={loadSample}>
              Try a sample token
            </button>
          </div>
        ) : !parsed.ok ? (
          <div className="jwt-banner bad card" role="alert">
            <strong>Not a JWT</strong>
            <span>{parsed.error}</span>
          </div>
        ) : (
          <>
            <StatusBanner status={status} now={now} kind={jwt!.kind} />

            <Panel title="Header" raw={header ? JSON.stringify(header, null, 2) : undefined}>
              {header ? <JsonView value={header} /> : <p className="jwt-note bad">{jwt!.header.error}</p>}
            </Panel>

            {jwt!.kind === 'jws' && (
              <Panel
                title="Payload"
                raw={payload ? JSON.stringify(payload, null, 2) : jwt!.payloadText}
                actions={
                  payload && (
                    <div className="jwt-seg" role="group" aria-label="Payload view">
                      <button type="button" aria-pressed={view === 'json'} onClick={() => setView('json')}>
                        JSON
                      </button>
                      <button type="button" aria-pressed={view === 'claims'} onClick={() => setView('claims')}>
                        Claims
                      </button>
                    </div>
                  )
                }
              >
                {payload ? (
                  view === 'json' ? (
                    <JsonView value={payload} />
                  ) : (
                    <ClaimsTable obj={payload} now={now} />
                  )
                ) : (
                  <>
                    <p className="jwt-note bad">{jwt!.payload.error}</p>
                    {jwt!.payloadText && <pre className="jwt-json mono">{jwt!.payloadText}</pre>}
                  </>
                )}
              </Panel>
            )}

            {jwt!.kind === 'jwe' && <p className="jwt-note">{jwt!.payload.error}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function StatusBanner({ status, now, kind }: { status: ReturnType<typeof timeStatus>; now: number; kind: 'jws' | 'jwe' }) {
  if (kind === 'jwe') {
    return (
      <div className="jwt-banner card">
        <strong>Encrypted token</strong>
        <span>Only the header can be read.</span>
      </div>
    );
  }
  switch (status.state) {
    case 'expired':
      return (
        <div className="jwt-banner bad card">
          <strong>Expired</strong>
          <span>
            {relative(status.exp, now)} · {fmtLocal(status.exp)}
          </span>
        </div>
      );
    case 'early':
      return (
        <div className="jwt-banner warn card">
          <strong>Not valid yet</strong>
          <span>
            Starts {relative(status.nbf, now)} · {fmtLocal(status.nbf)}
          </span>
        </div>
      );
    case 'valid':
      return (
        <div className="jwt-banner ok card">
          <strong>{status.exp !== undefined ? 'Not expired' : 'Active'}</strong>
          <span>{status.exp !== undefined ? `Expires ${relative(status.exp, now)} · ${fmtLocal(status.exp)}` : 'No expiry time (exp) set.'}</span>
        </div>
      );
    default:
      return (
        <div className="jwt-banner card">
          <strong>No expiry</strong>
          <span>This token has no exp claim.</span>
        </div>
      );
  }
}
