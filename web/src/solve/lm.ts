/** Small dense Levenberg–Marquardt with a forward-difference Jacobian (n ≲ 30 parameters). */

export interface LmOptions {
  maxIter?: number;
  lambda0?: number;
  tol?: number; // relative cost decrease that counts as converged
}

export interface LmResult {
  x: number[];
  cost: number; // ½ Σ r²
  r: number[];
  J: number[][]; // m × n at the solution
  iterations: number;
}

const sumSq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

export function jacobian(f: (x: number[]) => number[], x: number[], steps: number[], r0 = f(x)): number[][] {
  const m = r0.length, n = x.length;
  const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  const xt = [...x];
  for (let j = 0; j < n; j++) {
    const h = steps[j];
    xt[j] = x[j] + h;
    const r1 = f(xt);
    xt[j] = x[j];
    for (let i = 0; i < m; i++) J[i][j] = (r1[i] - r0[i]) / h;
  }
  return J;
}

/** Solves A x = b in place (Gaussian elimination with partial pivoting); null if singular. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

export function inverse(A: number[][]): number[][] | null {
  const n = A.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0);
    e[j] = 1;
    const c = solve(A, e);
    if (!c) return null;
    cols.push(c);
  }
  return A.map((_, i) => cols.map((c) => c[i]));
}

export function normalMatrix(J: number[][]): number[][] {
  const n = J[0]?.length ?? 0;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const row of J)
    for (let a = 0; a < n; a++) {
      if (!row[a]) continue;
      for (let b = a; b < n; b++) A[a][b] += row[a] * row[b];
    }
  for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
  return A;
}

export function levenbergMarquardt(f: (x: number[]) => number[], x0: number[], steps: number[], opts: LmOptions = {}): LmResult {
  const maxIter = opts.maxIter ?? 100;
  const tol = opts.tol ?? 1e-7;
  let lambda = opts.lambda0 ?? 1e-2;
  let x = [...x0];
  let r = f(x);
  let cost = 0.5 * sumSq(r);
  let J = jacobian(f, x, steps, r);
  let it = 0;
  for (; it < maxIter; it++) {
    const A = normalMatrix(J);
    const g = new Array(x.length).fill(0);
    for (let i = 0; i < r.length; i++) for (let j = 0; j < x.length; j++) g[j] += J[i][j] * r[i];
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v + lambda * Math.max(v, 1e-9) : v)));
      const dx = solve(Ad, g.map((v) => -v));
      if (!dx) {
        lambda *= 10;
        continue;
      }
      const xn = x.map((v, i) => v + dx[i]);
      const rn = f(xn);
      const cn = 0.5 * sumSq(rn);
      if (cn < cost) {
        const rel = (cost - cn) / Math.max(cost, 1e-12);
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(lambda / 3, 1e-9);
        improved = true;
        if (rel < tol) it = maxIter; // converged
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
    J = jacobian(f, x, steps, r);
  }
  return { x, cost, r, J, iterations: Math.min(it, maxIter) };
}
