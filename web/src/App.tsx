import { useStore, type Tab } from './store';
import { CapturePanel } from './ui/CapturePanel';
import { Scene } from './ui/Scene';
import { SetupPanel } from './ui/SetupPanel';
import { SolvePanel } from './ui/SolvePanel';
import { SurveyPanel } from './ui/SurveyPanel';
import { ValidatePanel } from './ui/ValidatePanel';

const TABS: { id: Tab; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'survey', label: 'Survey' },
  { id: 'capture', label: 'Capture' },
  { id: 'solve', label: 'Solve' },
  { id: 'validate', label: 'Validate' },
];

export function App() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const name = useStore((s) => s.setup.name);
  const fit = useStore((s) => s.fit);
  const truth = useStore((s) => s.simTruth);
  return (
    <div className="app">
      <div className="viewport">
        <Scene />
        <div className="overlay top-left">
          <strong>{name}</strong>
        </div>
        <div className="overlay bottom-left legend">
          <span><span className="dot" style={{ background: '#e6e9ee' }} />tag</span>
          <span><span className="dot" style={{ background: '#3ecf8e' }} />read on all ports</span>
          <span><span className="dot" style={{ background: '#ffd166' }} />some ports</span>
          <span><span className="dot" style={{ background: '#ff6b6b' }} />not read</span>
          {fit && <span className="muted">dashed grey = planned antenna</span>}
          {truth && <span style={{ color: '#3ecf8e' }}>green wire = simulated truth</span>}
        </div>
      </div>
      <div className="sidebar wide">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'setup' && <SetupPanel />}
        {tab === 'survey' && <SurveyPanel />}
        {tab === 'capture' && <CapturePanel />}
        {tab === 'solve' && <SolvePanel />}
        {tab === 'validate' && <ValidatePanel />}
      </div>
    </div>
  );
}
