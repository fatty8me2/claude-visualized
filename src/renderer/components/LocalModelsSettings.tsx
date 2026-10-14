import { useState } from 'react';
import { DEFAULT_LMSTUDIO_URL, DEFAULT_OLLAMA_URL, isLoopbackUrl, normalizeBaseUrl, type LocalModelsConfig, type LocalServerEntry } from '@core/localModels';

function UrlRow({ label, entry, def, onChange }: { label: string; entry: LocalServerEntry; def: string; onChange: (e: LocalServerEntry) => void }) {
  const [url, setUrl] = useState(entry.url);
  const norm = normalizeBaseUrl(url);
  const remote = norm !== null && !isLoopbackUrl(norm);
  return (
    <div className="row">
      <label className="chk" style={{ minWidth: 110 }}>
        <input type="checkbox" checked={entry.enabled} onChange={(e) => onChange({ ...entry, enabled: e.target.checked })} />
        {label}
      </label>
      <input style={{ width: 250 }} aria-label={`${label} URL`} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && norm && onChange({ ...entry, url: norm })} />
      <button disabled={!norm || norm === entry.url} onClick={() => norm && onChange({ ...entry, url: norm })}>
        Apply
      </button>
      <button
        disabled={entry.url === def && url === def}
        onClick={() => {
          setUrl(def);
          onChange({ ...entry, url: def });
        }}
      >
        Default
      </button>
      {url.trim() && !norm && <span style={{ color: 'var(--err)' }}>not a valid http(s) address</span>}
      {remote && <span style={{ color: 'var(--warn)' }}>remote host: status requests will be sent to it</span>}
    </div>
  );
}

export function LocalModelsSettings({ config }: { config: LocalModelsConfig }) {
  const [name, setName] = useState('');
  const [addr, setAddr] = useState('');
  const [poll, setPoll] = useState(String(config.pollSec));
  const save = (next: LocalModelsConfig) => void window.api.setConfig({ localModels: next });
  const addrNorm = normalizeBaseUrl(addr);
  const dup = addrNorm !== null && config.extra.some((e) => e.url === addrNorm);
  return (
    <div data-testid="local-settings">
      <h3 style={{ marginTop: 8 }}>Local models</h3>
      <p className="note">
        Status of local model servers is polled from this app's main process (read-only, nothing from your sessions is sent). Defaults are this computer only; a remote address is
        contacted only if you add it here.
      </p>
      <UrlRow label="Ollama" entry={config.ollama} def={DEFAULT_OLLAMA_URL} onChange={(ollama) => save({ ...config, ollama })} />
      <UrlRow label="LM Studio" entry={config.lmstudio} def={DEFAULT_LMSTUDIO_URL} onChange={(lmstudio) => save({ ...config, lmstudio })} />
      <div className="note" style={{ margin: '6px 0 2px' }}>
        Other OpenAI-compatible servers (llama.cpp server, vLLM, LocalAI, Jan, ...): <code>GET /v1/models</code>, plus <code>/health</code>, <code>/props</code>, <code>/slots</code>, <code>/metrics</code> on llama.cpp.
      </div>
      {config.extra.map((e) => (
        <div className="row" key={e.id}>
          <label className="chk" style={{ minWidth: 110 }}>
            <input type="checkbox" checked={e.enabled} onChange={(ev) => save({ ...config, extra: config.extra.map((x) => (x.id === e.id ? { ...x, enabled: ev.target.checked } : x)) })} />
            {e.name}
          </label>
          <code>{e.url}</code>
          {!isLoopbackUrl(e.url) && <span style={{ color: 'var(--warn)' }}>remote host</span>}
          <button onClick={() => save({ ...config, extra: config.extra.filter((x) => x.id !== e.id) })}>Remove</button>
        </div>
      ))}
      <div className="row">
        <input style={{ width: 110 }} placeholder="name" aria-label="Endpoint name" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ width: 250 }} placeholder="http://127.0.0.1:8080" aria-label="Endpoint URL" value={addr} onChange={(e) => setAddr(e.target.value)} />
        <button
          disabled={!addrNorm || dup}
          onClick={() => {
            if (!addrNorm) return;
            save({ ...config, extra: [...config.extra, { id: `openai:${addrNorm}`, name: name.trim() || new URL(addrNorm).host, url: addrNorm, enabled: true }] });
            setName('');
            setAddr('');
          }}
        >
          Add endpoint
        </button>
        {dup && <span className="note">already added</span>}
      </div>
      <div className="row">
        <span>Poll interval</span>
        <input style={{ width: 60 }} aria-label="Poll interval seconds" value={poll} onChange={(e) => setPoll(e.target.value.replace(/\D/g, ''))} />
        <span>seconds</span>
        <button disabled={!poll || Number(poll) < 2 || Number(poll) > 300 || Number(poll) === config.pollSec} onClick={() => save({ ...config, pollSec: Number(poll) })}>
          Apply
        </button>
        <span className="note">2 to 300; default 5. A server that is down is retried less often (up to every 60 s).</span>
      </div>
    </div>
  );
}
