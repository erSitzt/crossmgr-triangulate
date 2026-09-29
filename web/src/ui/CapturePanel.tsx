import { useEffect, useState } from 'react';
import { Check, NumField, Section, Select } from '@antenna/ui/controls';
import { openSocket, send, useLive } from '../capture/liveClient';
import { aggregate, parseSession } from '../capture/stats';
import { perturbSetup, synthCapture } from '../solve/synth';
import { useStore } from '../store';
import { pickFile } from './files';
import { portColor } from './Scene';

type Channels = 'fixed1' | 'fixed2' | 'fixed3' | 'fixed4' | 'hop';

export function CapturePanel() {
  return (
    <div className="panel">
      <ReaderSection />
      <OfflineSection />
      <MatrixSection />
    </div>
  );
}

function ReaderSection() {
  const setup = useStore((s) => s.setup);
  const reads = useStore((s) => s.reads.length);
  const live = useLive();
  const [host, setHost] = useState(() => localStorage.getItem('triangulate.host') ?? '192.168.1.50');
  const [mock, setMock] = useState(false);
  const [channels, setChannels] = useState<Channels>('fixed1');
  const [search, setSearch] = useState<'dual' | 'single'>('dual');
  const [label, setLabel] = useState('grid');
  const st = live.status;

  useEffect(() => openSocket(), []);

  const configure = () =>
    send({
      cmd: 'configure',
      antennas: setup.antennas.map((a) => ({ port: a.port, txDbm: a.txDbm, enabled: a.enabled })),
      rxSensDbm: setup.env.readerSensDbm,
      searchMode: search,
      session: 0,
      channels: channels === 'hop' ? [1, 2, 3, 4] : [Number(channels.slice(-1))],
    });

  return (
    <Section title="Reader (LLRP)" actions={<span className={live.socket === 'open' ? 'ok' : 'warn'}>bridge {live.socket}</span>}>
      <label className="field">
        <span>Reader host</span>
        <input value={host} onChange={(e) => { setHost(e.target.value); try { localStorage.setItem('triangulate.host', e.target.value); } catch { /* ignore */ } }} />
      </label>
      <Check label="Mock reader (no hardware)" value={mock} onChange={setMock} />
      <Select
        label="Channels"
        value={channels}
        onChange={setChannels}
        options={[
          { value: 'fixed1', label: 'Fixed 865.7 MHz (ch 1)' },
          { value: 'fixed2', label: 'Fixed 866.3 MHz (ch 2)' },
          { value: 'fixed3', label: 'Fixed 866.9 MHz (ch 3)' },
          { value: 'fixed4', label: 'Fixed 867.5 MHz (ch 4)' },
          { value: 'hop', label: 'All 4 ETSI channels' },
        ]}
      />
      <Select label="Search mode" value={search} onChange={setSearch} options={[{ value: 'dual', label: 'Dual target, session 0' }, { value: 'single', label: 'Single target, session 0' }]} />
      <p className="muted">Tx power per port comes from the setup ({setup.antennas.map((a) => `${a.port}: ${a.txDbm} dBm`).join(', ')}). Stop CrossMgrImpinj first – the reader takes one LLRP client only.</p>
      <div className="row">
        <button onClick={() => { openSocket(); send({ cmd: 'connect', host, mock }); }}>Connect</button>
        <button onClick={configure} disabled={!st.connected}>Push config</button>
        <button className="primary" onClick={() => { configure(); send({ cmd: 'start' }); }} disabled={!st.connected || st.running}>Start</button>
        <button onClick={() => send({ cmd: 'stop' })} disabled={!st.running}>Stop</button>
        <button onClick={() => send({ cmd: 'disconnect' })} disabled={!st.connected}>Disconnect</button>
      </div>
      <div className="row">
        <input className="grow" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="session label" />
        {st.recorder?.recording ? (
          <button className="danger" onClick={() => send({ cmd: 'stopRecord' })}>Stop recording ({st.recorder.count})</button>
        ) : (
          <button onClick={() => send({ cmd: 'record', label, meta: { survey: useStore.getState().survey, setupName: setup.name } })} disabled={!st.connected}>Record</button>
        )}
      </div>
      <p className="muted">{st.connected ? `${st.mode} ${st.host ?? ''} · ${st.running ? 'running' : 'idle'}` : 'not connected'} · {reads} reads in memory</p>
      <details>
        <summary className="muted">Log</summary>
        <pre className="log">{live.log.slice(-30).join('\n')}</pre>
      </details>
    </Section>
  );
}

function OfflineSection() {
  const setup = useStore((s) => s.setup);
  const survey = useStore((s) => s.survey);
  const setCapture = useStore((s) => s.setCapture);
  const clear = useStore((s) => s.clearCapture);
  const [dev, setDev] = useState({ posM: 0.8, angDeg: 12, offsetDb: 1.5, noiseDb: 3, seed: 1 });

  const loadSession = async () => {
    const text = await pickFile('.jsonl,.ndjson,.txt');
    if (!text) return;
    const { header, reads } = parseSession(text);
    setCapture(aggregate(reads, setup.antennas.map((a) => a.port)), 'file', String(header?.label ?? 'session file'), reads);
  };
  const simulate = () => {
    const truth = perturbSetup(setup, { posM: dev.posM, angDeg: dev.angDeg, offsetDb: dev.offsetDb, seed: dev.seed });
    setCapture(synthCapture(truth, survey, { noiseDb: dev.noiseDb, seed: dev.seed + 1000 }), 'sim', `simulated #${dev.seed}`, [], truth);
  };

  return (
    <Section title="Offline" actions={<><button onClick={loadSession}>Load session…</button><button onClick={clear}>Clear</button></>}>
      <p className="muted">
        Recorded sessions are in <code>sessions/</code> next to the server. The simulator moves the planned antennas by random mounting
        errors (shown green in 3D) and produces the capture the RF model predicts – a rehearsal for the solver.
      </p>
      <div className="grid3">
        <NumField label="Pos. error ±" value={dev.posM} unit="m" step={0.1} min={0} onChange={(v) => setDev({ ...dev, posM: v })} />
        <NumField label="Angle error ±" value={dev.angDeg} unit="°" step={1} min={0} onChange={(v) => setDev({ ...dev, angDeg: v })} />
        <NumField label="Offset ±" value={dev.offsetDb} unit="dB" step={0.5} min={0} onChange={(v) => setDev({ ...dev, offsetDb: v })} />
        <NumField label="RSSI scatter" value={dev.noiseDb} unit="dB" step={0.5} min={0} onChange={(v) => setDev({ ...dev, noiseDb: v })} />
        <NumField label="Seed" value={dev.seed} step={1} min={1} onChange={(v) => setDev({ ...dev, seed: Math.round(v) })} />
      </div>
      <div className="row"><button className="primary" onClick={simulate}>Simulate capture</button></div>
    </Section>
  );
}

function MatrixSection() {
  const capture = useStore((s) => s.capture);
  const label = useStore((s) => s.captureLabel);
  const source = useStore((s) => s.captureSource);
  const survey = useStore((s) => s.survey);
  const ports = useStore((s) => s.setup.antennas.filter((a) => a.enabled).map((a) => a.port));
  const selected = useStore((s) => s.selectedEpc);
  const set = useStore((s) => s.set);
  if (!capture) return <Section title="Capture"><p className="muted">No capture yet.</p></Section>;
  const known = new Set(survey.tags.map((t) => t.epc));
  const extra = Object.keys(capture.tags).filter((e) => !known.has(e));
  const complete = survey.tags.filter((t) => t.enabled && capture.tags[t.epc]).length;
  return (
    <Section title={`Capture · ${label || source}`}>
      <p className="muted">{capture.durationS.toFixed(1)} s · {complete}/{survey.tags.filter((t) => t.enabled).length} reference tags seen · cells: reads/s · median RSSI</p>
      <table className="tbl matrix">
        <thead>
          <tr><th>Tag</th>{ports.map((p) => <th key={p} style={{ color: portColor(p) }}>Port {p}</th>)}</tr>
        </thead>
        <tbody>
          {survey.tags.filter((t) => t.enabled).map((t) => (
            <tr key={t.epc} className={t.epc === selected ? 'sel' : ''} onClick={() => set({ selectedEpc: t.epc })}>
              <td title={t.pos.join(', ')}>{t.epc}</td>
              {ports.map((p) => {
                const c = capture.tags[t.epc]?.[p];
                return <td key={p} className={c ? '' : 'miss'}>{c ? `${c.ratePerS.toFixed(0)} · ${c.medianRssi.toFixed(1)}` : '–'}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {extra.length > 0 && <p className="muted">Not in the survey: {extra.slice(0, 12).join(', ')}{extra.length > 12 ? ' …' : ''}</p>}
    </Section>
  );
}
