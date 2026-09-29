import { useEffect, useMemo, useState } from 'react';
import type { Setup, Vec3 } from '@antenna/model/types';
import { Check, NumField, Section } from '@antenna/ui/controls';
import { send, useLive } from '../capture/liveClient';
import { parseSession } from '../capture/stats';
import { DEFAULT_SYNTH_WALK, synthWalk } from '../phase/synthWalk';
import { prepareWalk, type Walk } from '../phase/walk';
import { perturbSetup } from '../solve/synth';
import type { FitResult } from '../solve/rssiFit';
import { phaseFitAsync } from '../solve/workerClient';
import { useStore } from '../store';
import { pickFile } from './files';
import { portColor } from './Scene';

let walkSeq = 0;
const newWalk = (label: string, from: Vec3, to: Vec3, epc = 'WALK0001'): Walk => ({ id: `walk-${Date.now().toString(36)}-${walkSeq++}`, label, epc, from, to, reads: [] });

/** Centre line low, across under the arch high, and low along the track edge in front of each upright that carries antennas. */
export function recommendedWalks(setup: Setup): Walk[] {
  const t = setup.trusses[0];
  const half = t ? t.spanM / 2 : 4;
  const x0 = t ? t.position[0] : 0;
  const walks = [
    newWalk('centre, low', [x0 - 4, 0.4, 0], [x0 + 4, 0.4, 0]),
    newWalk('across, high', [x0 + 1.5, 1.6, -(half - 0.8)], [x0 + 1.5, 1.6, half - 0.8]),
  ];
  const sides = new Set(setup.antennas.filter((a) => a.enabled && a.mount && a.mount.member !== 'top').map((a) => a.mount!.member));
  for (const a of setup.antennas.filter((a) => a.enabled && !a.mount && Math.abs(a.position[2]) > 1.5)) sides.add(a.position[2] < 0 ? 'left' : 'right');
  if (sides.has('left')) walks.push(newWalk('left edge, low', [x0 - 3, 0.3, -(half - 0.8)], [x0 + 3, 0.3, -(half - 0.8)]));
  if (sides.has('right')) walks.push(newWalk('right edge, low', [x0 - 3, 0.3, half - 0.8], [x0 + 3, 0.3, half - 0.8]));
  return walks;
}

export function PhasePanel() {
  const st = useStore();
  const { setup, walks, survey, capture, specs, priors, simTruth, phaseFit, solving } = st;
  const [sigmaCm, setSigmaCm] = useState(1);
  const [knotS, setKnotS] = useState(1);
  const [refine, setRefine] = useState(true);
  const [maxGapS, setMaxGapS] = useState(0.12);
  const prepared = useMemo(() => walks.map((w) => (w.reads.length ? prepareWalk(w, { maxGapS, fallbackMHz: setup.env.freqMHz }) : null)), [walks, maxGapS, setup.env.freqMHz]);
  const liveEpcs = useMemo(() => [...new Set(st.reads.slice(-20000).map((r) => r.epc))], [st.reads]);
  const live = useLive();
  const isMock = live.status.connected && live.status.mode === 'mock';
  const [timeScale, setTimeScale] = useState(1);
  // walk played back by the mock reader: fill its reads once the server reports it done
  const [pending, setPending] = useState<{ id: string; epc: string; afterSeq: number } | null>(null);
  const mw = live.status.walk;
  useEffect(() => {
    if (!pending || !mw?.done || mw.seq <= pending.afterSeq) return; // a newer walk than the one before the click
    const s = useStore.getState();
    const reads = s.reads.filter((r) => r.walk === mw.seq && r.epc === pending.epc && r.phase != null);
    s.setWalks(s.walks.map((w) => (w.id === pending.id ? { ...w, reads } : w)));
    setPending(null);
  }, [mw?.done, mw?.seq, pending]);

  const update = (i: number, p: Partial<Walk>) => st.setWalks(walks.map((w, j) => (j === i ? { ...w, ...p } : w)));
  const setEnd = (i: number, end: 'from' | 'to', k: number, v: number) => {
    const p = [...walks[i][end]] as Vec3;
    p[k] = v;
    update(i, { [end]: p, reads: [] });
  };
  const truth = () => {
    if (simTruth) return simTruth;
    const t = perturbSetup(setup, { posM: 0.8, angDeg: 12, offsetDb: 1.5, seed: 1 });
    st.set({ simTruth: t });
    return t;
  };

  const mockWalk = (w: Walk) => {
    const t = truth();
    send({ cmd: 'configure', antennas: setup.antennas.map((a) => ({ port: a.port, txDbm: a.txDbm, enabled: a.enabled })), rxSensDbm: setup.env.readerSensDbm, channels: [1] });
    send({
      cmd: 'mockWalk',
      epc: w.epc,
      from: w.from,
      to: w.to,
      speed: 0.35,
      standS: 3,
      timeScale,
      antennas: t.antennas.filter((a) => a.enabled).map((a) => ({ port: a.port, position: a.position })),
    });
    setPending({ id: w.id, epc: w.epc, afterSeq: mw?.seq ?? 0 });
  };

  const run = async () => {
    const ws = walks.filter((w) => w.reads.length);
    if (!ws.length) return;
    st.set({ solving: true });
    try {
      const useRssi = refine && !!capture;
      const r = await phaseFitAsync(setup, ws, { maxGapS, fallbackMHz: setup.env.freqMHz }, useRssi ? survey : null, useRssi ? capture : null, {
        specs,
        priors,
        sigmaDb: st.sigmaDb,
        starts: st.starts,
        phase: { sigmaM: sigmaCm / 100, knotSpacingS: knotS },
      });
      // make the result the current fit (3D view, Validate, Export)
      const fit: FitResult = r.rssi
        ? { ...r.rssi, params: [...r.phase.params, ...r.rssi.params], warnings: [...r.phase.warnings, ...r.rssi.warnings] }
        : { antennas: r.phase.antennas, params: r.phase.params, obs: [], cost: r.phase.cost, rmsDb: 0, startsTried: 0, iterations: r.phase.iterations, warnings: r.phase.warnings };
      st.set({ phaseFit: r, fit, fitFor: 'phase', solving: false });
    } catch (e) {
      st.set({ solving: false });
      alert(`Phase fit failed: ${e}`);
    }
  };

  return (
    <div className="panel">
      <Section
        title="Phase walks"
        actions={
          <>
            <button onClick={() => st.setWalks(recommendedWalks(setup))}>Recommended</button>
            <button onClick={() => st.setWalks([...walks, newWalk(`walk ${walks.length + 1}`, [-4, 1, 0], [4, 1, 0])])}>+ Walk</button>
          </>
        }
      >
        <p className="muted">
          Carry one tag on a pole along a chalked straight line: <b>stand 3 s on the start mark, walk slowly (≤ 0.5 m/s), stand 3 s on the end mark</b>. Fixed channel,
          nobody else in the zone. Walk crossing lines at different heights plus one low in front of each upright – one line alone leaves a mirror ambiguity.
        </p>
        {walks.map((w, i) => {
          const pw = prepared[i];
          return (
            <div key={w.id} className="walk">
              <div className="row">
                <input className="grow" value={w.label} onChange={(e) => update(i, { label: e.target.value })} />
                <input className="epc" list="walk-epcs" value={w.epc} onChange={(e) => update(i, { epc: e.target.value.trim().toUpperCase(), reads: [] })} title="EPC of the walked tag" />
                <button className="danger" onClick={() => st.setWalks(walks.filter((_, j) => j !== i))}>×</button>
              </div>
              {(['from', 'to'] as const).map((end) => (
                <div className="row" key={end}>
                  <span className="muted end">{end}</span>
                  {[0, 1, 2].map((k) => (
                    <input key={k} className="num" type="number" step={0.1} value={w[end][k]} onChange={(e) => setEnd(i, end, k, parseFloat(e.target.value) || 0)} title={'xyz'[k]} />
                  ))}
                </div>
              ))}
              <div className="row">
                <button onClick={() => update(i, { reads: st.reads.filter((r) => r.epc === w.epc && r.phase != null) })}>From live reads</button>
                <button
                  onClick={async () => {
                    const t = await pickFile('.jsonl,.ndjson,.txt');
                    if (t) update(i, { reads: parseSession(t).reads });
                  }}
                >
                  Load session…
                </button>
                <button onClick={() => update(i, { reads: synthWalk(truth(), survey, w, { ...DEFAULT_SYNTH_WALK, seed: i + 1 }).reads.map((r) => ({ ...r, epc: w.epc })) })}>Simulate</button>
                {isMock && (
                  <button disabled={!!pending} onClick={() => mockWalk(w)} title="Play this walk back through the mock reader (live reads, like a real walk)">
                    {pending?.id === w.id ? `Walking… ${mw && mw.seq > pending.afterSeq ? `${mw.s.toFixed(1)}/${mw.length.toFixed(1)} m` : ''}` : 'Mock walk'}
                  </button>
                )}
              </div>
              {pw ? (
                <p className="muted">
                  {w.reads.length} reads · motion {pw.tStart.toFixed(1)}–{pw.tEnd.toFixed(1)} s ({(pw.lengthM / Math.max(0.1, pw.tEnd - pw.tStart)).toFixed(2)} m/s) ·{' '}
                  {pw.segments.length} segments · ports {Object.entries(pw.readsPerPort).map(([p, n]) => `${p}: ${n}`).join(', ')}
                  {pw.warnings.map((m, j) => <span key={j} className="warn"><br />{m}</span>)}
                </p>
              ) : (
                <p className="muted">no reads yet</p>
              )}
            </div>
          );
        })}
        {isMock && (
          <div className="row">
            <span className="muted">Mock walk speed-up</span>
            <select value={timeScale} onChange={(e) => setTimeScale(Number(e.target.value))}>
              {[1, 2, 4, 8].map((v) => <option key={v} value={v}>{v}×</option>)}
            </select>
            <span className="muted">The mock plays the green "true" antennas (Offline → Simulate sets them).</span>
          </div>
        )}
        <datalist id="walk-epcs">{liveEpcs.map((e) => <option key={e} value={e} />)}</datalist>
      </Section>
      <Section title="Fit">
        <div className="grid3">
          <NumField label="Range scatter" value={sigmaCm} unit="cm" step={0.5} min={0.2} onChange={setSigmaCm} title="phase noise + multipath per read" />
          <NumField label="Speed knots every" value={knotS} unit="s" step={0.5} min={0.3} onChange={setKnotS} />
          <NumField label="Max read gap" value={maxGapS} unit="s" step={0.02} min={0.02} onChange={setMaxGapS} title="longer gaps in one port/channel series restart the phase unwrapping" />
        </div>
        <Check label={`Then fit yaw/pitch/gain from the RSSI capture${capture ? '' : ' (no capture loaded)'}`} value={refine && !!capture} onChange={setRefine} />
        <p className="muted">Pose modes and priors come from the Solve tab. Antennas on a truss are placed freely at their measured phase centre (the plan is the prior).</p>
        <div className="row">
          <button className="primary" disabled={solving || !walks.some((w) => w.reads.length)} onClick={run}>{solving ? 'Fitting…' : 'Fit positions'}</button>
        </div>
      </Section>
      {phaseFit && (
        <Section title={`Result · range rms ${(phaseFit.phase.rmsM * 100).toFixed(1)} cm · phase sign ${phaseFit.phase.sign > 0 ? '+' : '−'}`}>
          <table className="tbl">
            <thead><tr><th>Port</th><th>x</th><th>y</th><th>z</th><th>Yaw / pitch</th>{simTruth && <th>Error</th>}</tr></thead>
            <tbody>
              {phaseFit.setup.antennas.filter((a) => a.enabled).map((a) => {
                const sd = (k: string) => phaseFit.phase.params.find((p) => p.antennaId === a.id && p.key === k)?.sd;
                const t = simTruth?.antennas.find((x) => x.id === a.id);
                const cell = (k: number) => {
                  const s = sd('xyz'[k]);
                  return <td key={k}>{a.position[k].toFixed(3)}{s !== undefined && <span className="muted"> ±{(s * 100).toFixed(1)}</span>}</td>;
                };
                return (
                  <tr key={a.id}>
                    <td><span className="dot" style={{ background: portColor(a.port) }} />{a.port}</td>
                    {[0, 1, 2].map(cell)}
                    <td>{a.yawDeg.toFixed(1)}° / {a.pitchDeg.toFixed(1)}°</td>
                    {t && <td>{(Math.hypot(a.position[0] - t.position[0], a.position[1] - t.position[1], a.position[2] - t.position[2]) * 100).toFixed(1)} cm</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">± in cm (1σ). Per walk: {phaseFit.phase.walks.map((w) => `${w.label} ${(w.rmsM * 100).toFixed(1)} cm (${w.reads} reads)`).join(' · ')}</p>
          {phaseFit.phase.warnings.map((w, i) => <p key={i} className="warn">{w}</p>)}
          <p className="muted">The result is now the current fit: shown in 3D, used by Validate, exported from the Solve tab.</p>
        </Section>
      )}
    </div>
  );
}
