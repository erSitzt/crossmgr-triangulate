import { useMemo, useState } from 'react';
import { Section, Select } from '@antenna/ui/controls';
import { compare, groundScan, portSummary, type GroundScore } from '../validate/validate';
import { useStore } from '../store';
import { portColor } from './Scene';

const resClass = (r: number | null, margin: number) => {
  if (r === null) return margin > 3 ? 'miss' : 'muted';
  const a = Math.abs(r);
  return a < 3 ? 'good' : a < 6 ? 'meh' : 'bad';
};

export function ValidatePanel() {
  const { setup, survey, capture, fit } = useStore();
  const selected = useStore((s) => s.selectedEpc);
  const set = useStore((s) => s.set);
  const [which, setWhich] = useState<'planned' | 'fitted'>(fit ? 'fitted' : 'planned');
  const [ground, setGround] = useState<GroundScore[] | null>(null);
  const antennas = which === 'fitted' && fit ? fit.antennas : setup.antennas;
  const obs = useMemo(() => (capture ? compare(setup, antennas, survey, capture) : []), [setup, antennas, survey, capture]);
  const ports = setup.antennas.filter((a) => a.enabled).map((a) => a.port);

  if (!capture) return <div className="panel"><p className="muted">Capture or simulate first.</p></div>;
  const summary = portSummary(obs);
  const byTag = new Map<string, typeof obs>();
  for (const o of obs) byTag.set(o.epc, [...(byTag.get(o.epc) ?? []), o]);

  return (
    <div className="panel">
      <Section title="Model vs measurement">
        <Select label="Antennas" value={which} onChange={setWhich} options={[{ value: 'planned', label: 'Planned (setup)' }, ...(fit ? [{ value: 'fitted' as const, label: 'Fitted' }] : [])]} />
        <table className="tbl">
          <thead><tr><th>Port</th><th>Read</th><th>Mean Δ</th><th>RMS</th><th title="model says readable, never read">Missed</th><th title="read although the model says out of range">Unexpected</th></tr></thead>
          <tbody>
            {summary.map((p) => (
              <tr key={p.port}>
                <td><span className="dot" style={{ background: portColor(p.port) }} />{p.port}</td>
                <td>{p.read}</td>
                <td>{p.meanDb >= 0 ? '+' : ''}{p.meanDb.toFixed(1)} dB</td>
                <td>{p.rmsDb.toFixed(1)} dB</td>
                <td className={p.missed ? 'warn' : ''}>{p.missed}</td>
                <td className={p.unexpected ? 'warn' : ''}>{p.unexpected}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Δ = measured − model. A mean offset common to all ports points at tag backscatter or reader calibration, one port alone at its cable/antenna.</p>
      </Section>
      <Section title="Per tag (Δ dB, · = not read)">
        <table className="tbl matrix">
          <thead><tr><th>Tag</th><th>Pos</th>{ports.map((p) => <th key={p} style={{ color: portColor(p) }}>{p}</th>)}</tr></thead>
          <tbody>
            {[...byTag.entries()].map(([epc, list]) => {
              const t = survey.tags[list[0].tagIndex];
              return (
                <tr key={epc} className={epc === selected ? 'sel' : ''} onClick={() => set({ selectedEpc: epc })}>
                  <td>{epc}</td>
                  <td className="muted">{t.pos.map((v) => v.toFixed(1)).join(' ')}</td>
                  {ports.map((p) => {
                    const o = list.find((x) => x.port === p)!;
                    return (
                      <td key={p} className={resClass(o.residualDb, o.margin)} title={`model ${o.predicted.toFixed(1)} dBm, margin ${o.margin.toFixed(1)} dB`}>
                        {o.residualDb === null ? '·' : `${o.residualDb >= 0 ? '+' : ''}${o.residualDb.toFixed(1)}`}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted"><span className="miss">·</span> red = the model expects a read there (margin &gt; 3 dB), but the tag was never read.</p>
      </Section>
      <Section title="Ground scan" actions={<button onClick={() => setGround(groundScan(setup, antennas, survey, capture))}>Run</button>}>
        <p className="muted">Replays the capture against every ground material (offset removed). Needs tags at several heights.</p>
        {ground && (
          <table className="tbl">
            <thead><tr><th>Ground</th><th>RMS</th><th>Offset</th></tr></thead>
            <tbody>
              {ground.map((g, i) => (
                <tr key={g.presetId} className={i === 0 ? 'best' : ''}>
                  <td>{g.name}{g.presetId === setup.env.ground.presetId ? ' (current)' : ''}</td>
                  <td>{g.rmsDb.toFixed(2)} dB</td>
                  <td>{g.meanDb.toFixed(1)} dB</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
