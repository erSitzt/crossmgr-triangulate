import type { Antenna, Setup } from '@antenna/model/types';
import { GROUND_PRESETS } from '@antenna/rf/ground';
import type { Capture } from '../capture/stats';
import { makeRefModel } from '../solve/model';
import { buildObservations, type ObsResult } from '../solve/rssiFit';
import type { Survey } from '../survey/types';

export interface PortSummary {
  port: number;
  read: number;
  meanDb: number; // mean(measured - model): > 0 = reality stronger than the model
  rmsDb: number;
  missed: number; // model says readable (margin > 3 dB), but never read
  unexpected: number; // read although the model says unreadable (margin < -3 dB)
}

export function portSummary(obs: ObsResult[]): PortSummary[] {
  const ports = [...new Set(obs.map((o) => o.port))].sort((a, b) => a - b);
  return ports.map((port) => {
    const po = obs.filter((o) => o.port === port);
    const rs = po.filter((o) => o.residualDb !== null).map((o) => o.residualDb!);
    const mean = rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : 0;
    return {
      port,
      read: rs.length,
      meanDb: mean,
      rmsDb: rs.length ? Math.sqrt(rs.reduce((s, v) => s + v * v, 0) / rs.length) : 0,
      missed: po.filter((o) => o.rssi === null && o.margin > 3).length,
      unexpected: po.filter((o) => o.rssi !== null && o.margin < -3).length,
    };
  });
}

/** Model vs measurement for a given set of antennas (planned or fitted), without fitting anything. */
export function compare(setup: Setup, antennas: Antenna[], survey: Survey, capture: Capture): ObsResult[] {
  const s = { ...setup, antennas };
  const model = makeRefModel(s, survey);
  const byPort = new Map(antennas.filter((a) => a.enabled).map((a) => [a.port, model.antennaCtx(a)]));
  return buildObservations(s, survey, capture).map((o) => {
    const l = model.link(byPort.get(o.port)!, o.tagIndex);
    return { ...o, predicted: l.rssiDbm, margin: l.margin, residualDb: o.rssi === null ? null : o.rssi - l.rssiDbm };
  });
}

export interface GroundScore {
  presetId: string;
  name: string;
  rmsDb: number;
  meanDb: number;
}

/**
 * Which ground material explains the measurements best (with the given antennas). The ground
 * reflection shapes the vertical RSSI profile, so a survey with several heights separates them.
 * The mean residual is removed first: a global offset (tag backscatter, reader calibration) is not
 * a ground property.
 */
export function groundScan(setup: Setup, antennas: Antenna[], survey: Survey, capture: Capture): GroundScore[] {
  return GROUND_PRESETS.map((g) => {
    const { name, ...ground } = g;
    const s: Setup = { ...setup, env: { ...setup.env, ground, terrainGround: ground } };
    const rs = compare(s, antennas, survey, capture).filter((o) => o.residualDb !== null).map((o) => o.residualDb!);
    const mean = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
    const rms = rs.length ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length) : 0;
    return { presetId: g.presetId, name, rmsDb: rms, meanDb: mean };
  }).sort((a, b) => a.rmsDb - b.rmsDb);
}
