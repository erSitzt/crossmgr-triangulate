import type { Setup } from '@antenna/model/types';
import type { Capture } from '../capture/stats';
import type { AntennaFitSpec, Priors } from '../solve/params';
import { fitRssi, type FitResult } from '../solve/rssiFit';
import type { Survey } from '../survey/types';
import { fitPhase, type PhaseFitOptions, type PhaseFitResult } from './phaseFit';
import type { PreparedWalk } from './walk';

export interface CombinedOptions {
  specs: AntennaFitSpec[];
  priors?: Priors;
  phase?: Omit<PhaseFitOptions, 'specs' | 'priors'>;
  sigmaDb?: number;
  starts?: number;
}

export interface CombinedResult {
  phase: PhaseFitResult;
  rssi: FitResult | null;
  setup: Setup; // setup with the final antennas
}

/**
 * Phase walks fix the positions (cm); the RSSI capture of the reference tags then fixes yaw/pitch
 * and the gain offset with the positions held. Fitted antennas leave their truss mount: their
 * measured position is kept as it is instead of being re-derived from member offset and aim.
 */
export function fitCombined(setup: Setup, walks: PreparedWalk[], survey: Survey | null, capture: Capture | null, o: CombinedOptions): CombinedResult {
  const phase = fitPhase(setup, walks, { ...o.phase, specs: o.specs, priors: o.priors });
  const placed: Setup = { ...setup, antennas: phase.antennas };
  if (!capture || !survey) return { phase, rssi: null, setup: placed };
  const angleSpecs = o.specs.map((s) => ({ ...s, mode: s.mode === 'fixed' ? ('fixed' as const) : ('angles' as const) }));
  const rssi = fitRssi(placed, survey, capture, { specs: angleSpecs, priors: o.priors, sigmaDb: o.sigmaDb, starts: o.starts });
  return { phase, rssi, setup: { ...setup, antennas: rssi.antennas } };
}
