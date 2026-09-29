import type { Setup } from '@antenna/model/types';
import type { Capture } from '../capture/stats';
import type { CombinedOptions, CombinedResult } from '../phase/combined';
import type { PrepareOptions, Walk } from '../phase/walk';
import type { Survey } from '../survey/types';
import type { FitOptions, FitResult } from './rssiFit';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: never) => void; reject: (e: Error) => void }>();

function request<T>(msg: Record<string, unknown>): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: never; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result!);
    };
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: never) => void, reject });
    worker!.postMessage({ ...msg, id });
  });
}

export const fitAsync = (setup: Setup, survey: Survey, capture: Capture, opts: FitOptions) =>
  request<FitResult>({ kind: 'rssi', setup, survey, capture, opts });

export const phaseFitAsync = (setup: Setup, walks: Walk[], prepare: PrepareOptions, survey: Survey | null, capture: Capture | null, opts: CombinedOptions) =>
  request<CombinedResult>({ kind: 'phase', setup, walks, prepare, survey, capture, opts });
