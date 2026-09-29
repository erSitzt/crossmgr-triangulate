import type { Antenna, Setup } from '@antenna/model/types';
import { normalizeSetup } from '@antenna/model/normalize';

/**
 * The original crossmgr-antenna setup with the fitted antennas swapped in (matched by id); track,
 * truss, profiles and simulation settings stay as they were. Load it in crossmgr-antenna via
 * Setup → Import.
 */
export function mergeFitted(original: Setup, fitted: Antenna[], note = 'fitted'): Setup {
  const byId = new Map(fitted.map((a) => [a.id, a]));
  return normalizeSetup({
    ...original,
    name: `${original.name} (${note})`,
    antennas: original.antennas.map((a) => byId.get(a.id) ?? a),
  });
}

export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url;
  el.download = filename;
  el.click();
  URL.revokeObjectURL(url);
}
