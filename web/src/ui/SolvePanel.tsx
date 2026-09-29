import { NumField, Section } from '@antenna/ui/controls';
import type { Antenna } from '@antenna/model/types';
import { downloadJson, mergeFitted } from '../export';
import type { ParamKey, PoseMode } from '../solve/params';
import { fitAsync } from '../solve/workerClient';
import { defaultSpecs, useStore } from '../store';
import { portColor } from './Scene';

const UNIT: Record<ParamKey, string> = { x: 'm', y: 'm', z: 'm', along: 'm', yaw: '°', pitch: '°', offset: 'dB' };

function truthValue(t: Antenna | undefined, plan: Antenna, key: ParamKey): number | null {
  if (!t) return null;
  switch (key) {
    case 'x': return t.position[0];
    case 'y': return t.position[1];
    case 'z': return t.position[2];
    case 'along': return t.mount?.alongM ?? null;
    case 'yaw': return t.yawDeg;
    case 'pitch': return t.pitchDeg;
    case 'offset': return t.cableLossDb - plan.cableLossDb;
  }
}

export function SolvePanel() {
  const st = useStore();
  const { setup, survey, capture, specs, priors, fit, solving, simTruth } = st;

  const run = async () => {
    if (!capture) return;
    st.set({ solving: true });
    try {
      const fit = await fitAsync(setup, survey, capture, { specs, priors, sigmaDb: st.sigmaDb, starts: st.starts });
      st.set({ fit, fitFor: st.captureLabel, solving: false });
    } catch (e) {
      st.set({ solving: false });
      alert(`Fit failed: ${e}`);
    }
  };
  const setSpec = (id: string, p: Partial<{ mode: PoseMode; fitOffset: boolean }>) =>
    st.setSpecs((specs.length ? specs : defaultSpecs(setup)).map((s) => (s.antennaId === id ? { ...s, ...p } : s)));

  return (
    <div className="panel">
      <Section title="What to fit">
        <table className="tbl">
          <thead><tr><th>Port</th><th>Antenna</th><th>Pose</th><th>Gain offset</th></tr></thead>
          <tbody>
            {setup.antennas.filter((a) => a.enabled).map((a) => {
              const s = specs.find((x) => x.antennaId === a.id) ?? { mode: 'free' as PoseMode, fitOffset: true };
              return (
                <tr key={a.id}>
                  <td><span className="dot" style={{ background: portColor(a.port) }} />{a.port}</td>
                  <td>{a.name}</td>
                  <td>
                    <select value={s.mode} onChange={(e) => setSpec(a.id, { mode: e.target.value as PoseMode })}>
                      {a.mount && <option value="mount">on truss ({a.mount.member})</option>}
                      <option value="free">free x/y/z</option>
                      <option value="fixed">fixed</option>
                    </select>
                  </td>
                  <td><input type="checkbox" checked={s.fitOffset} onChange={(e) => setSpec(a.id, { fitOffset: e.target.checked })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted">"On truss" keeps the antenna on its member (offset along it plus yaw/pitch): fewer unknowns, better results.</p>
      </Section>
      <Section title="Solver">
        <div className="grid3">
          <NumField label="Position ±" value={priors.posSdM} unit="m" step={0.1} min={0.1} onChange={(v) => st.set({ priors: { ...priors, posSdM: v } })} title="1σ prior: how far off the plan the antenna may be" />
          <NumField label="Angle ±" value={priors.angSdDeg} unit="°" step={1} min={1} onChange={(v) => st.set({ priors: { ...priors, angSdDeg: v } })} />
          <NumField label="Offset ±" value={priors.offsetSdDb} unit="dB" step={0.5} min={0.1} onChange={(v) => st.set({ priors: { ...priors, offsetSdDb: v } })} />
          <NumField label="RSSI scatter" value={st.sigmaDb} unit="dB" step={0.5} min={0.5} onChange={(v) => st.set({ sigmaDb: v })} title="model-vs-reality scatter of a median RSSI" />
          <NumField label="Starts / antenna" value={st.starts} step={1} min={1} max={200} onChange={(v) => st.set({ starts: Math.round(v) })} />
        </div>
        <div className="row">
          <button className="primary" disabled={!capture || solving} onClick={run}>{solving ? 'Solving…' : 'Fit antennas'}</button>
          {!capture && <span className="muted">Capture or simulate first.</span>}
        </div>
      </Section>
      {fit && (
        <Section
          title={`Result · rms ${fit.rmsDb.toFixed(2)} dB`}
          actions={
            <>
              <button onClick={() => downloadJson(mergeFitted(setup, fit.antennas), `${setup.name} (fitted).json`)}>Export setup</button>
              <button onClick={() => confirm('Use the fitted antennas as the new plan?') && st.set({ setup: mergeFitted(setup, fit.antennas), fit: null })}>Apply</button>
            </>
          }
        >
          <table className="tbl">
            <thead><tr><th>Port</th><th>Param</th><th>Planned</th><th>Fitted ± 1σ</th>{simTruth && <th>True</th>}</tr></thead>
            <tbody>
              {fit.params.map((p, i) => {
                const a = setup.antennas.find((x) => x.id === p.antennaId)!;
                const plan = p.key === 'offset' ? 0 : p.prior.mean;
                const t = truthValue(simTruth?.antennas.find((x) => x.id === p.antennaId), a, p.key);
                const dp = p.key === 'yaw' || p.key === 'pitch' ? 1 : 2;
                return (
                  <tr key={i}>
                    <td><span className="dot" style={{ background: portColor(a.port) }} />{a.port}</td>
                    <td>{p.key}</td>
                    <td>{plan.toFixed(dp)}</td>
                    <td className={p.sd > (p.key === 'offset' ? 2 : p.key === 'yaw' || p.key === 'pitch' ? 10 : 0.5) ? 'warn' : ''}>
                      {p.value.toFixed(dp)} ± {p.sd.toFixed(dp)} {UNIT[p.key]}
                    </td>
                    {simTruth && <td>{t === null ? '' : t.toFixed(dp)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {fit.warnings.map((w, i) => <p key={i} className="warn">{w}</p>)}
          <p className="muted">{fit.obs.filter((o) => o.rssi !== null).length} RSSI observations, {fit.obs.filter((o) => o.rssi === null).length} not-read constraints, {fit.iterations} LM iterations.</p>
        </Section>
      )}
    </div>
  );
}
