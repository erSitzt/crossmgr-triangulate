import { useState } from 'react';
import type { Vec3 } from '@antenna/model/types';
import { NumField, Section } from '@antenna/ui/controls';
import { downloadJson } from '../export';
import { useStore } from '../store';
import { gridSurvey, parseSurvey, type RefTag } from '../survey/types';
import { parseList, pickFile } from './files';

const AXES: { label: string; v: Vec3 }[] = [
  { label: 'vertical', v: [0, 1, 0] },
  { label: 'across (Z)', v: [0, 0, 1] },
  { label: 'along (X)', v: [1, 0, 0] },
];
const axisLabel = (v: Vec3) => AXES.find((a) => a.v.every((x, i) => Math.abs(x - v[i]) < 1e-6))?.label ?? 'custom';

export function SurveyPanel() {
  const survey = useStore((s) => s.survey);
  const setSurvey = useStore((s) => s.setSurvey);
  const capture = useStore((s) => s.capture);
  const selected = useStore((s) => s.selectedEpc);
  const set = useStore((s) => s.set);
  const [grid, setGrid] = useState({ xs: '-2, 0, 2', zs: '-3, 0, 3', ys: '0.4, 1.2' });

  const known = new Set(survey.tags.map((t) => t.epc));
  const unknown = Object.keys(capture?.tags ?? {}).filter((e) => !known.has(e));

  const update = (i: number, p: Partial<RefTag>) =>
    setSurvey({ ...survey, tags: survey.tags.map((t, j) => (j === i ? { ...t, ...p } : t)) });
  const setPos = (i: number, k: number, v: number) => {
    const pos = [...survey.tags[i].pos] as Vec3;
    pos[k] = v;
    update(i, { pos });
  };
  const n = (s: string) => (Number.isFinite(parseFloat(s)) ? parseFloat(s) : 0);

  return (
    <div className="panel">
      <Section
        title="Reference tags"
        actions={
          <>
            <button
              onClick={async () => {
                const t = await pickFile('.json');
                if (t) try { setSurvey(parseSurvey(JSON.parse(t))); } catch (e) { alert(String(e)); }
              }}
            >
              Import…
            </button>
            <button onClick={() => downloadJson(survey, 'survey.json')}>Export</button>
          </>
        }
      >
        <p className="muted">
          Tags on non-metallic stakes, positions measured from the finish-line centre on the ground (metres: +X direction of travel,
          +Z rider's right, Y up). Spread them over the read zone at 2–3 heights, at least 0.5 m apart. EPCs seen by the reader are
          offered in the EPC field.
        </p>
        <table className="tbl survey">
          <thead>
            <tr><th /><th>EPC</th><th>x</th><th>y</th><th>z</th><th>Dipole</th><th /></tr>
          </thead>
          <tbody>
            {survey.tags.map((t, i) => (
              <tr key={i} className={t.epc === selected ? 'sel' : ''} onClick={() => set({ selectedEpc: t.epc })}>
                <td><input type="checkbox" checked={t.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} /></td>
                <td><input className="epc" list="seen-epcs" value={t.epc} onChange={(e) => update(i, { epc: e.target.value.trim().toUpperCase() })} /></td>
                {[0, 1, 2].map((k) => (
                  <td key={k}><input className="num" type="number" step={0.05} value={t.pos[k]} onChange={(e) => setPos(i, k, n(e.target.value))} /></td>
                ))}
                <td>
                  <select value={axisLabel(t.axis)} onChange={(e) => update(i, { axis: AXES.find((a) => a.label === e.target.value)?.v ?? t.axis })}>
                    {AXES.map((a) => <option key={a.label}>{a.label}</option>)}
                    {axisLabel(t.axis) === 'custom' && <option>custom</option>}
                  </select>
                </td>
                <td><button className="danger" title="Remove" onClick={() => setSurvey({ ...survey, tags: survey.tags.filter((_, j) => j !== i) })}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="seen-epcs">{unknown.map((e) => <option key={e} value={e} />)}</datalist>
        <div className="row">
          <button
            onClick={() =>
              setSurvey({
                ...survey,
                tags: [...survey.tags, { epc: unknown[0] ?? `REF${String(survey.tags.length + 1).padStart(4, '0')}`, name: '', pos: [0, 1, 0], axis: [0, 1, 0], enabled: true }],
              })
            }
          >
            + Tag
          </button>
          <span className="muted">{survey.tags.length} tags · {unknown.length} unassigned EPCs in the capture</span>
        </div>
      </Section>
      <Section
        title="Generate grid"
        actions={
          <button
            onClick={() =>
              confirm('Replace all reference tags with a grid?') &&
              setSurvey({ ...gridSurvey(parseList(grid.xs), parseList(grid.zs), parseList(grid.ys)), tag: survey.tag })
            }
          >
            Generate
          </button>
        }
      >
        {(['xs', 'zs', 'ys'] as const).map((k) => (
          <label className="field" key={k}>
            <span>{k === 'xs' ? 'X (along)' : k === 'zs' ? 'Z (across)' : 'Heights'}</span>
            <input value={grid[k]} onChange={(e) => setGrid({ ...grid, [k]: e.target.value })} />
            <em>m</em>
          </label>
        ))}
        <p className="muted">Placeholder EPCs REF0001…: replace them with the real EPCs (or program the tags accordingly).</p>
      </Section>
      <Section title="Reference tag model">
        <NumField label="Chip sensitivity" value={survey.tag.sensitivityDbm} unit="dBm" step={0.5} onChange={(v) => setSurvey({ ...survey, tag: { ...survey.tag, sensitivityDbm: v } })} />
        <NumField label="Tag gain" value={survey.tag.gainDbi} unit="dBi" step={0.5} onChange={(v) => setSurvey({ ...survey, tag: { ...survey.tag, gainDbi: v } })} />
        <NumField label="Backscatter loss" value={survey.tag.backscatterLossDb} unit="dB" step={0.5} onChange={(v) => setSurvey({ ...survey, tag: { ...survey.tag, backscatterLossDb: v } })} />
        <NumField label="Polarisation loss" value={survey.tag.polLossDb} unit="dB" step={0.5} onChange={(v) => setSurvey({ ...survey, tag: { ...survey.tag, polLossDb: v } })} />
      </Section>
    </div>
  );
}
