/// <reference lib="webworker" />
import { fitRssi, type FitOptions } from './rssiFit';
import type { Setup } from '@antenna/model/types';
import type { Capture } from '../capture/stats';
import type { Survey } from '../survey/types';

export interface FitRequest {
  id: number;
  setup: Setup;
  survey: Survey;
  capture: Capture;
  opts: FitOptions;
}

self.onmessage = (e: MessageEvent<FitRequest>) => {
  const { id, setup, survey, capture, opts } = e.data;
  try {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, result: fitRssi(setup, survey, capture, opts) });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) });
  }
};
