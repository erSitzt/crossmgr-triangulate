/// <reference lib="webworker" />
import type { Setup } from '@antenna/model/types';
import type { Capture } from '../capture/stats';
import { fitCombined, type CombinedOptions } from '../phase/combined';
import { prepareWalk, type PrepareOptions, type Walk } from '../phase/walk';
import type { Survey } from '../survey/types';
import { fitRssi, type FitOptions } from './rssiFit';

export type WorkerRequest =
  | { id: number; kind: 'rssi'; setup: Setup; survey: Survey; capture: Capture; opts: FitOptions }
  | { id: number; kind: 'phase'; setup: Setup; walks: Walk[]; prepare: PrepareOptions; survey: Survey | null; capture: Capture | null; opts: CombinedOptions };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const q = e.data;
  try {
    const result =
      q.kind === 'rssi'
        ? fitRssi(q.setup, q.survey, q.capture, q.opts)
        : fitCombined(q.setup, q.walks.map((w) => prepareWalk(w, q.prepare)), q.survey, q.capture, q.opts);
    (self as DedicatedWorkerGlobalScope).postMessage({ id: q.id, result });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id: q.id, error: String(err) });
  }
};
