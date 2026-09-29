import { Canvas } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import type { Antenna, AntennaProfile, Setup } from '@antenna/model/types';
import { boresight, DEG } from '@antenna/rf/math';
import { TrackMesh } from '@antenna/scene/TrackMesh';
import { TrussMesh } from '@antenna/scene/TrussMesh';
import { useStore } from '../store';

const PORT_COLORS = ['#3e8ef7', '#f7a23e', '#b36bff', '#3ecf8e'];
export const portColor = (port: number) => PORT_COLORS[(port - 1) % PORT_COLORS.length];

type Variant = 'planned' | 'fitted' | 'truth';

function AntennaGlyph({ a, profile, variant }: { a: Antenna; profile?: AntennaProfile; variant: Variant }) {
  const [w, h, d] = profile?.sizeM ?? [0.3, 0.3, 0.05];
  const color = variant === 'truth' ? '#3ecf8e' : variant === 'planned' ? '#8b95a3' : portColor(a.port);
  const b = boresight(a.yawDeg, a.pitchDeg);
  const tip: [number, number, number] = [a.position[0] + b[0] * 1.2, a.position[1] + b[1] * 1.2, a.position[2] + b[2] * 1.2];
  return (
    <group>
      <mesh position={a.position} rotation={[a.pitchDeg * DEG, a.yawDeg * DEG, a.rollDeg * DEG, 'YXZ']}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} wireframe={variant !== 'fitted'} transparent opacity={variant === 'fitted' ? 1 : 0.7} />
      </mesh>
      <Line points={[a.position, tip]} color={color} lineWidth={variant === 'fitted' ? 2.5 : 1.2} dashed={variant === 'planned'} dashSize={0.1} gapSize={0.06} />
      {variant === 'fitted' && (
        <Html position={[a.position[0], a.position[1] + h / 2 + 0.15, a.position[2]]} center className="scene-label">
          {a.port}
        </Html>
      )}
    </group>
  );
}

function Antennas({ setup, antennas, variant }: { setup: Setup; antennas: Antenna[]; variant: Variant }) {
  return (
    <>
      {antennas.filter((a) => a.enabled).map((a) => (
        <AntennaGlyph key={`${variant}-${a.id}`} a={a} variant={variant} profile={setup.antennaProfiles.find((p) => p.id === a.profileId)} />
      ))}
    </>
  );
}

function RefTags() {
  const survey = useStore((s) => s.survey);
  const capture = useStore((s) => s.capture);
  const selected = useStore((s) => s.selectedEpc);
  const set = useStore((s) => s.set);
  const ports = useStore((s) => s.setup.antennas.filter((a) => a.enabled).map((a) => a.port));
  return (
    <>
      {survey.tags.map((t) => {
        const seen = capture?.tags[t.epc];
        const nPorts = seen ? ports.filter((p) => seen[p]).length : 0;
        const color = !t.enabled ? '#555' : !capture ? '#e6e9ee' : nPorts === 0 ? '#ff6b6b' : nPorts < ports.length ? '#ffd166' : '#3ecf8e';
        const sel = t.epc === selected;
        return (
          <group key={t.epc}>
            <mesh position={t.pos} onClick={(e) => { e.stopPropagation(); set({ selectedEpc: sel ? null : t.epc }); }}>
              <sphereGeometry args={[sel ? 0.1 : 0.07, 16, 12]} />
              <meshStandardMaterial color={color} emissive={sel ? '#ffffff' : '#000000'} emissiveIntensity={0.3} />
            </mesh>
            <Line points={[[t.pos[0], 0, t.pos[2]], t.pos]} color="#6b5a3a" lineWidth={2} />
          </group>
        );
      })}
    </>
  );
}

export function Scene() {
  const setup = useStore((s) => s.setup);
  const fit = useStore((s) => s.fit);
  const truth = useStore((s) => s.simTruth);
  return (
    <Canvas camera={{ position: [-9, 6, -9], fov: 45 }} shadows={false}>
      <color attach="background" args={['#15181c']} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 10, 3]} intensity={0.9} />
      <gridHelper args={[40, 40, '#333a44', '#262b33']} />
      <TrackMesh track={setup.track} />
      {setup.trusses.map((t) => <TrussMesh key={t.id} truss={t} selected={false} onSelect={() => {}} />)}
      <Antennas setup={setup} antennas={setup.antennas} variant={fit ? 'planned' : 'fitted'} />
      {fit && <Antennas setup={setup} antennas={fit.antennas} variant="fitted" />}
      {truth && <Antennas setup={setup} antennas={truth.antennas} variant="truth" />}
      <RefTags />
      <OrbitControls target={[0, 1, 0]} makeDefault />
    </Canvas>
  );
}
