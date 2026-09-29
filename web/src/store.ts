import { create } from 'zustand';
import type { Setup } from '@antenna/model/types';
import { migrateSetup } from '@antenna/model/normalize';
import { makeDefaultSetup } from '@antenna/presets/templates';
import { aggregate, type Capture, type Read } from './capture/stats';
import { DEFAULT_PRIORS, type AntennaFitSpec, type Priors } from './solve/params';
import type { CombinedResult } from './phase/combined';
import type { Walk } from './phase/walk';
import type { FitResult } from './solve/rssiFit';
import { makeDefaultSurvey, parseSurvey, type Survey } from './survey/types';

export type Tab = 'setup' | 'survey' | 'capture' | 'solve' | 'phase' | 'validate';
export type CaptureSource = 'live' | 'file' | 'sim';

const MAX_READS = 500_000;
const LS_KEY = 'crossmgr-triangulate.v1';

interface Persisted {
  setup: Setup;
  survey: Survey;
  specs: AntennaFitSpec[];
  walks: Walk[]; // persisted without reads
}

function load(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return { setup: migrateSetup(p.setup), survey: parseSurvey(p.survey), specs: p.specs, walks: (p.walks ?? []).map((w: Walk) => ({ ...w, reads: [] })) };
  } catch {
    return {};
  }
}

export const defaultSpecs = (setup: Setup): AntennaFitSpec[] =>
  setup.antennas.map((a) => ({ antennaId: a.id, mode: a.mount ? 'mount' : 'free', fitOffset: true }));

interface State extends Persisted {
  tab: Tab;
  reads: Read[];
  capture: Capture | null;
  captureSource: CaptureSource | null;
  captureLabel: string;
  priors: Priors;
  sigmaDb: number;
  starts: number;
  fit: FitResult | null;
  fitFor: string | null; // capture label the fit belongs to
  solving: boolean;
  /** "real world" used by the simulated capture, to compare against the fit */
  simTruth: Setup | null;
  selectedEpc: string | null;
  phaseFit: CombinedResult | null;

  setTab(t: Tab): void;
  setSetup(s: Setup): void;
  setSurvey(s: Survey): void;
  setSpecs(s: AntennaFitSpec[]): void;
  setWalks(w: Walk[]): void;
  addReads(r: Read[]): void;
  /** reads that belong to a phase walk: kept, but they do not replace the current capture */
  addWalkReads(r: Read[]): void;
  setCapture(c: Capture, source: CaptureSource, label: string, reads?: Read[], truth?: Setup | null): void;
  clearCapture(): void;
  set(p: Partial<State>): void;
}

const init = load();
const initSetup = init.setup ?? makeDefaultSetup();

export const useStore = create<State>((set, get) => ({
  setup: initSetup,
  survey: init.survey ?? makeDefaultSurvey(),
  specs: init.specs?.length ? init.specs : defaultSpecs(initSetup),
  walks: init.walks ?? [],
  phaseFit: null,
  tab: 'setup',
  reads: [],
  capture: null,
  captureSource: null,
  captureLabel: '',
  priors: DEFAULT_PRIORS,
  sigmaDb: 3,
  starts: 24,
  fit: null,
  fitFor: null,
  solving: false,
  simTruth: null,
  selectedEpc: null,

  setTab: (tab) => set({ tab }),
  setSetup: (setup) => set({ setup, specs: defaultSpecs(setup), fit: null, phaseFit: null }),
  setSurvey: (survey) => set({ survey, fit: null }),
  setSpecs: (specs) => set({ specs }),
  setWalks: (walks) => set({ walks, phaseFit: null }),
  addReads: (r) => {
    const reads = get().reads.concat(r);
    set({ reads: reads.length > MAX_READS ? reads.slice(-MAX_READS) : reads, captureSource: 'live' });
  },
  addWalkReads: (r) => {
    const reads = get().reads.concat(r);
    set({ reads: reads.length > MAX_READS ? reads.slice(-MAX_READS) : reads });
  },
  setCapture: (capture, captureSource, captureLabel, reads = [], simTruth = null) =>
    set({ capture, captureSource, captureLabel, reads, simTruth, fit: null }),
  clearCapture: () => set({ reads: [], capture: null, captureSource: null, captureLabel: '', simTruth: null, fit: null }),
  set: (p) => set(p),
}));

/** Live reads are aggregated at most once a second. */
let aggTimer: number | undefined;
useStore.subscribe((s, prev) => {
  if (s.reads === prev.reads || s.captureSource !== 'live') return;
  if (aggTimer !== undefined) return;
  aggTimer = window.setTimeout(() => {
    aggTimer = undefined;
    const st = useStore.getState();
    if (st.captureSource === 'live') useStore.setState({ capture: aggregate(st.reads, st.setup.antennas.map((a) => a.port)) });
  }, 1000);
});

useStore.subscribe((s, prev) => {
  if (s.setup === prev.setup && s.survey === prev.survey && s.specs === prev.specs && s.walks === prev.walks) return;
  try {
    const walks = s.walks.map((w) => ({ ...w, reads: [] }));
    localStorage.setItem(LS_KEY, JSON.stringify({ setup: s.setup, survey: s.survey, specs: s.specs, walks }));
  } catch {
    /* storage unavailable: keep working in memory */
  }
});
