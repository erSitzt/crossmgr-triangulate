import { migrateSetup } from '@antenna/model/normalize';
import { makeDefaultSetup } from '@antenna/presets/templates';
import { Section } from '@antenna/ui/controls';
import { downloadJson } from '../export';
import { useStore } from '../store';
import { pickFile } from './files';
import { portColor } from './Scene';

const f2 = (v: number) => v.toFixed(2);

export function SetupPanel() {
  const setup = useStore((s) => s.setup);
  const setSetup = useStore((s) => s.setSetup);

  const importSetup = async () => {
    const text = await pickFile('.json');
    if (!text) return;
    try {
      setSetup(migrateSetup(JSON.parse(text)));
    } catch (e) {
      alert(`Not a crossmgr-antenna setup: ${e}`);
    }
  };

  return (
    <div className="panel">
      <Section
        title="Planned setup"
        actions={
          <>
            <button className="primary" onClick={importSetup}>Import…</button>
            <button onClick={() => downloadJson(setup, `${setup.name}.json`)}>Export</button>
            <button onClick={() => confirm('Replace with the default setup?') && setSetup(makeDefaultSetup())}>Default</button>
          </>
        }
      >
        <p>
          <b>{setup.name}</b>
        </p>
        <p className="muted">
          Export the setup from crossmgr-antenna (Setup → Export) and import it here. Track, truss, antenna profiles, Tx power, cable
          loss and ground are taken from it. The fit estimates where the antennas really are.
        </p>
      </Section>
      <Section title="Antennas">
        <table className="tbl">
          <thead>
            <tr>
              <th>Port</th><th>Name</th><th>Mount</th><th>x / y / z (m)</th><th>Yaw</th><th>Pitch</th><th>Tx</th><th>Cable</th>
            </tr>
          </thead>
          <tbody>
            {setup.antennas.map((a) => (
              <tr key={a.id} className={a.enabled ? '' : 'muted'}>
                <td><span className="dot" style={{ background: portColor(a.port) }} />{a.port}</td>
                <td>{a.name}</td>
                <td>{a.mount ? `${a.mount.member} ${f2(a.mount.alongM)}` : 'free'}</td>
                <td>{a.position.map(f2).join(' / ')}</td>
                <td>{a.yawDeg.toFixed(0)}°</td>
                <td>{a.pitchDeg.toFixed(0)}°</td>
                <td>{a.txDbm}</td>
                <td>{a.cableLossDb}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Enter the measured cable loss per port in crossmgr-antenna before exporting. The fit then only has to find a small residual
          offset instead of trading gain against distance.
        </p>
      </Section>
      <Section title="Environment">
        <p className="muted">
          Ground {setup.env.ground.presetId} (εr {setup.env.ground.epsR}), reflection {setup.env.groundReflection ? 'on' : 'off'},{' '}
          {setup.env.freqMHz} MHz, reader sensitivity {setup.env.readerSensDbm} dBm. Validate → Ground scan shows which material fits
          the measurements best.
        </p>
      </Section>
    </div>
  );
}
