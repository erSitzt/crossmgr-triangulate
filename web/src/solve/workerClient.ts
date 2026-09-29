import type { Setup } from '@antenna/model/types';
import type { Capture } from '../capture/stats';
import type { Survey } from '../survey/types';
import type { FitOptions, FitResult } from './rssiFit';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: FitResult) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: FitResult; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result!);
    };
  }
  return worker;
}

export function fitAsync(setup: Setup, survey: Survey, capture: Capture, opts: FitOptions): Promise<FitResult> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, setup, survey, capture, opts });
  });
}
