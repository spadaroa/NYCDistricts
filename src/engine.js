/* NYC School District Builder — model, metrics and optimizer.
 * Runs in the browser (window.Engine) and in Node (module.exports).
 * A "plan" is an Int16Array: plan[unit] = district index (0..K-1) or -1 (unassigned).
 */
(function (root) {
  "use strict";
  const BOROS = ["M", "X", "K", "Q", "R"];
  const BORO_NAMES = { M: "Manhattan", X: "Bronx", K: "Brooklyn", Q: "Queens", R: "Staten Island" };
  const GROUPS = ["asian", "black", "hisp", "white", "multi", "other"];
  const NG = GROUPS.length;

  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- model ----------
  // groups: string of school groups to count, e.g. "C" or "CHSR"
  //   C community superintendent, H high school superintendent, S District 75, A District 79, R charter
  function buildModel(data, groups) {
    const mode = groups;
    const F = {}; data.meta.fields.forEach((f, i) => (F[f] = i));
    const U = data.units, n = U.length;
    const m = {
      n, mode,
      E: new Float64Array(n), G: Array.from({ length: NG }, () => new Float64Array(n)), native: new Float64Array(n),
      pov: new Float64Array(n), ell: new Float64Array(n), swd: new Float64Array(n), eniW: new Float64Array(n),
      ns: new Int32Array(n), area: new Float64Array(n), perim: new Float64Array(n),
      x: new Float64Array(n), y: new Float64Array(n), boro: new Int8Array(n), cur: new Int16Array(n),
      nbStart: new Int32Array(n + 1), nb: null, nbLen: null, schoolsIn: [],
      // schools whose administrative district differs from the district their zone is in:
      // out[i] = [{ admin (0-based), E, G[], pov, native, ell, swd, eniW }]
      out: Array.from({ length: n }, () => null),
    };
    const nbs = [], nls = [];
    for (let i = 0; i < n; i++) {
      const u = U[i];
      m.area[i] = u.a; m.perim[i] = u.p; m.x[i] = u.x; m.y[i] = u.y;
      m.boro[i] = BOROS.indexOf(u.b); m.cur[i] = u.cur - 1;
      m.nbStart[i] = nbs.length;
      for (const [j, L] of u.nb) { nbs.push(j); nls.push(L); }
      const inc = [];
      for (const si of u.s) {
        const s = data.schools[si];
        if (groups.indexOf(s[F.grp]) < 0) continue;
        inc.push(si);
        const N = s[F.n];
        m.E[i] += N;
        const a = s[F.asian], b = s[F.black], h = s[F.hisp], w = s[F.white], mu = s[F.multi];
        m.G[0][i] += a; m.G[1][i] += b; m.G[2][i] += h; m.G[3][i] += w; m.G[4][i] += mu;
        m.G[5][i] += Math.max(0, N - a - b - h - w - mu); m.native[i] += s[F.native];
        m.pov[i] += s[F.pov]; m.ell[i] += s[F.ell]; m.swd[i] += s[F.swd]; m.eniW[i] += s[F.eni] * N;
        const ad = s[F.admin];
        if (ad && ad !== u.cur) {
          (m.out[i] = m.out[i] || []).push({ admin: ad - 1, E: N, G: [a, b, h, w, mu, Math.max(0, N - a - b - h - w - mu)],
            native: s[F.native], pov: s[F.pov], ell: s[F.ell], swd: s[F.swd], eniW: s[F.eni] * N, ns: 1 });
        }
      }
      m.ns[i] = inc.length; m.schoolsIn.push(inc);
    }
    m.nbStart[n] = nbs.length;
    m.nb = Int32Array.from(nbs); m.nbLen = Float64Array.from(nls);
    let E = 0; const Gt = new Array(NG).fill(0); let P = 0;
    const boroE = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      E += m.E[i]; P += m.pov[i]; boroE[m.boro[i]] += m.E[i];
      for (let g = 0; g < NG; g++) Gt[g] += m.G[g][i];
    }
    m.totE = E || 1; m.Pg = Gt.map((v) => v / E); m.Ppov = P / E; m.boroE = boroE;
    return m;
  }

  // ---------- helpers ----------
  function districtBoros(m, plan, K) {
    // borough of each district = borough with most units (ties by enrollment)
    const cnt = Array.from({ length: K }, () => [0, 0, 0, 0, 0]);
    for (let i = 0; i < m.n; i++) if (plan[i] >= 0) cnt[plan[i]][m.boro[i]] += 1 + m.E[i] / 1e6;
    return cnt.map((c) => { let b = -1, best = 0; c.forEach((v, k) => { if (v > best) { best = v; b = k; } }); return b; });
  }
  function targets(m, plan, K, lock) {
    if (!lock) return new Float64Array(K).fill(m.totE / K);
    const db = districtBoros(m, plan, K);
    const seats = [0, 0, 0, 0, 0]; db.forEach((b) => b >= 0 && seats[b]++);
    return Float64Array.from(db.map((b) => (b >= 0 && seats[b] ? m.boroE[b] / seats[b] : m.totE / K)));
  }
  function apportion(m, K) { // Hamilton method, at least 1 seat per borough
    const q = m.boroE.map((e) => (e / m.totE) * K);
    const seats = q.map((v) => Math.max(1, Math.floor(v)));
    let left = K - seats.reduce((a, b) => a + b, 0);
    const order = q.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; left > 0; k = (k + 1) % 5, left--) seats[order[k][1]]++;
    while (left < 0) { const i = seats.indexOf(Math.max(...seats)); seats[i]--; left++; }
    return seats;
  }
  function components(m, plan, d) {
    const seen = new Uint8Array(m.n); let comps = 0;
    for (let i = 0; i < m.n; i++) {
      if (plan[i] !== d || seen[i]) continue;
      comps++; const st = [i]; seen[i] = 1;
      while (st.length) {
        const a = st.pop();
        for (let k = m.nbStart[a]; k < m.nbStart[a + 1]; k++) {
          const b = m.nb[k]; if (plan[b] === d && !seen[b]) { seen[b] = 1; st.push(b); }
        }
      }
    }
    return comps;
  }
  const entropy = (ps) => ps.reduce((s, p) => (p > 0 ? s - p * Math.log(p) : s), 0);

  // ---------- metrics for display ----------
  function stats(m, plan, K, opts) {
    opts = opts || {};
    const T = targets(m, plan, K, opts.lock !== false);
    const db = districtBoros(m, plan, K);
    const D = Array.from({ length: K }, (_, d) => ({
      d, E: 0, G: new Array(NG).fill(0), native: 0, pov: 0, ell: 0, swd: 0, eniW: 0, ns: 0, units: 0, area: 0, perim: 0,
      cx: 0, cy: 0, boros: new Set(), boro: db[d], target: T[d],
    }));
    let unassigned = 0, unassignedE = 0, changedE = 0, assignedE = 0;
    const pin = opts.pin;
    const addTo = (s, o, k) => {
      s.E += k * o.E; for (let g = 0; g < NG; g++) s.G[g] += k * o.G[g]; s.native += k * o.native;
      s.pov += k * o.pov; s.ell += k * o.ell; s.swd += k * o.swd; s.eniW += k * o.eniW; s.ns += k * o.ns;
    };
    for (let i = 0; i < m.n; i++) {
      const d = plan[i];
      if (d < 0) { unassigned++; unassignedE += m.E[i]; continue; }
      const s = D[d];
      s.E += m.E[i]; for (let g = 0; g < NG; g++) s.G[g] += m.G[g][i]; s.native += m.native[i];
      s.pov += m.pov[i]; s.ell += m.ell[i]; s.swd += m.swd[i]; s.eniW += m.eniW[i]; s.ns += m.ns[i];
      let outE = 0;
      if (m.out[i]) for (const o of m.out[i]) {
        outE += o.E;
        const dest = pin && pin[i] && o.admin < K ? o.admin : d;
        if (dest !== d) { addTo(s, o, -1); addTo(D[dest], o, 1); }
        if (dest !== o.admin) changedE += o.E;
      }
      if (m.cur[i] !== d) changedE += m.E[i] - outE;
      s.units++; s.area += m.area[i]; s.cx += m.x[i] * m.area[i]; s.cy += m.y[i] * m.area[i];
      s.boros.add(m.boro[i]);
      let p = m.perim[i];
      for (let k = m.nbStart[i]; k < m.nbStart[i + 1]; k++) if (plan[m.nb[k]] === d) p -= m.nbLen[k];
      s.perim += p;
      assignedE += m.E[i];
    }
    let maxDev = 0, sumDev2 = 0, nonContig = 0, ppSum = 0, used = 0, withinPov = 0, splitB = 0;
    const Ent = entropy(m.Pg); let H = 0, Dpov = 0, Hecon = 0;
    const EntP = entropy([m.Ppov, 1 - m.Ppov]);
    let usedE = 0, nUsed = 0; for (const s of D) if (s.units) { usedE += s.E; nUsed++; }
    const cityAvg = usedE / Math.max(1, nUsed);
    let maxDevCity = 0;
    const P = m.Ppov, E = assignedE || 1;
    let totPov = 0; D.forEach((s) => (totPov += s.pov));
    for (const s of D) {
      if (s.units === 0) { s.empty = true; continue; }
      used++;
      s.dev = s.target > 0 ? (s.E - s.target) / s.target : 0;
      maxDev = Math.max(maxDev, Math.abs(s.dev)); sumDev2 += s.dev * s.dev;
      s.devCity = cityAvg > 0 ? (s.E - cityAvg) / cityAvg : 0; s.cityAvg = cityAvg;
      maxDevCity = Math.max(maxDevCity, Math.abs(s.devCity));
      s.pct = s.G.map((v) => (s.E ? v / s.E : 0));
      s.nativePct = s.E ? s.native / s.E : 0; s.povPct = s.E ? s.pov / s.E : 0; s.ellPct = s.E ? s.ell / s.E : 0; s.swdPct = s.E ? s.swd / s.E : 0;
      s.eni = s.E ? s.eniW / s.E : 0;
      s.pp = s.perim > 0 ? (4 * Math.PI * s.area) / (s.perim * s.perim) : 0;
      ppSum += s.pp;
      s.cx /= s.area; s.cy /= s.area;
      s.comps = components(m, plan, s.d); if (s.comps > 1) nonContig++;
      if (s.boros.size > 1) splitB++;
      if (Math.abs(s.povPct - P) <= 0.1) withinPov++;
      // local Theil terms: how much less diverse this district is than the city (0 = same as city; negative = more diverse)
      s.raceH = Ent > 0 && s.E > 0 ? (Ent - entropy(s.pct)) / Ent : 0;
      s.econH = EntP > 0 && s.E > 0 ? (EntP - entropy([s.povPct, 1 - s.povPct])) / EntP : 0;
      if (s.E > 0) { H += s.E * (Ent - entropy(s.pct)); Hecon += s.E * (EntP - entropy([s.povPct, 1 - s.povPct])); }
      Dpov += Math.abs(s.pov / (totPov || 1) - (s.E - s.pov) / (E - totPov || 1));
    }
    return {
      districts: D,
      summary: {
        K, used, maxDev, rmsDev: Math.sqrt(sumDev2 / Math.max(1, used)), nonContig, crossBoro: splitB,
        avgPP: ppSum / Math.max(1, used), theilH: Ent > 0 ? H / (E * Ent) : 0, dissimPov: Dpov / 2,
        theilEcon: EntP > 0 ? Hecon / (E * EntP) : 0, maxDevCity, cityAvg,
        withinPov, changed: changedE / E, unassigned, unassignedE, totE: m.totE, Ppov: P, Pg: m.Pg,
      },
    };
  }

  // ---------- optimizer ----------
  // weights: {pop, compact, econ, race, change}; maxDev hard-ish cap; lock: stay within borough
  const SCALE = { pop: 0.02, compact: 0.25, econ: 0.05, race: 0.05, change: 0.1 };

  function Optimizer(m, plan, K, opts) {
    this.m = m; this.plan = plan; this.K = K;
    this.w = Object.assign({ pop: 1, compact: 0.3, econ: 0, race: 0, change: 0 }, opts.weights || {});
    this.maxDev = opts.maxDev == null ? 0.05 : opts.maxDev;
    this.lock = opts.lock !== false;
    this.r = rng(opts.seed || 1);
    this.pin = opts.pin || new Uint8Array(m.n);
    // only optimize assigned units; unassigned ones stay put
    this.T = targets(m, plan, K, this.lock);
    this.db = districtBoros(m, plan, K);
    const A = (this.agg = {
      E: new Float64Array(K), G: Array.from({ length: NG }, () => new Float64Array(K)), pov: new Float64Array(K),
      A: new Float64Array(K), Sx: new Float64Array(K), Sy: new Float64Array(K), Sr: new Float64Array(K),
      ch: new Float64Array(K), cnt: new Int32Array(K),
    });
    for (let i = 0; i < m.n; i++) { const d = plan[i]; if (d >= 0) this._add(i, d, 1, this.pin[i]); }
    this.iter = 0;
    this.econDen = m.totE * m.Ppov * (1 - m.Ppov) || 1;
    this.raceDen = m.totE * m.Pg.reduce((s, p) => s + p * (1 - p), 0) || 1;
    this.terms = Array.from({ length: K }, (_, d) => this._term(d));
    this.sums = [0, 0, 0, 0, 0, 0];
    for (const t of this.terms) for (let k = 0; k < 6; k++) this.sums[k] += t[k];
    this.score = this._score(this.sums);
  }
  // add (s=+1) or remove (s=-1) unit i as part of district d; pinned outlier schools stay with their admin district
  Optimizer.prototype._add = function (i, d, s, pinned) {
    const m = this.m, A = this.agg, a = m.area[i];
    A.E[d] += s * m.E[i]; for (let g = 0; g < NG; g++) A.G[g][d] += s * m.G[g][i];
    A.pov[d] += s * m.pov[i]; A.A[d] += s * a; A.Sx[d] += s * a * m.x[i]; A.Sy[d] += s * a * m.y[i];
    A.Sr[d] += s * a * (m.x[i] * m.x[i] + m.y[i] * m.y[i]); A.cnt[d] += s;
    let outE = 0;
    if (m.out[i]) for (const o of m.out[i]) {
      outE += o.E;
      const dest = pinned && o.admin < this.K ? o.admin : d;
      if (dest !== d) {
        A.E[d] -= s * o.E; A.E[dest] += s * o.E; A.pov[d] -= s * o.pov; A.pov[dest] += s * o.pov;
        for (let g = 0; g < NG; g++) { A.G[g][d] -= s * o.G[g]; A.G[g][dest] += s * o.G[g]; }
      }
      if (dest !== o.admin) A.ch[dest] += s * o.E;
    }
    if (m.cur[i] !== d) A.ch[d] += s * (m.E[i] - outE);
  };
  // per-district term vector: [dev², econ, race, compact, change, overCap]
  Optimizer.prototype._term = function (d) {
    const A = this.agg, m = this.m;
    if (A.cnt[d] === 0) return [1, 0, 0, 0, 0, 1];
    const E = A.E[d], T = this.T[d];
    const dev = T > 0 ? (E - T) / T : 0;
    const over = Math.max(0, Math.abs(dev) - this.maxDev);
    let econ = 0, race = 0;
    if (E > 0 && this.econDen) {
      const p = A.pov[d] / E - m.Ppov; econ = (E * p * p) / this.econDen;
      for (let g = 0; g < NG; g++) { const q = A.G[g][d] / E - m.Pg[g]; race += E * q * q; }
      race /= this.raceDen;
    }
    const Ar = A.A[d], cx = A.Sx[d] / Ar, cy = A.Sy[d] / Ar;
    const I = A.Sr[d] - Ar * (cx * cx + cy * cy);
    const nmi = (2 * Math.PI * I) / (Ar * Ar); // 1 for a disc
    return [dev * dev, econ, race, Math.max(0, nmi - 1), A.ch[d] / m.totE, over * over];
  };
  Optimizer.prototype._score = function (S) {
    const w = this.w, K = this.K;
    return (
      (w.pop * Math.sqrt(S[0] / K)) / SCALE.pop +
      (w.econ * Math.sqrt(Math.max(0, S[1]))) / SCALE.econ +
      (w.race * Math.sqrt(Math.max(0, S[2]))) / SCALE.race +
      (w.compact * (S[3] / K)) / SCALE.compact +
      (w.change * S[4]) / SCALE.change +
      (S[5] * 4e4)
    );
  };
  Optimizer.prototype._staysConnected = function (u, d) {
    // does district d stay connected if u is removed?
    const m = this.m, plan = this.plan;
    const seeds = [];
    for (let k = m.nbStart[u]; k < m.nbStart[u + 1]; k++) if (plan[m.nb[k]] === d) seeds.push(m.nb[k]);
    if (seeds.length <= 1) return true;
    const want = new Set(seeds); const seen = new Set([u, seeds[0]]); const st = [seeds[0]];
    want.delete(seeds[0]);
    while (st.length && want.size) {
      const a = st.pop();
      for (let k = m.nbStart[a]; k < m.nbStart[a + 1]; k++) {
        const b = m.nb[k];
        if (plan[b] === d && !seen.has(b)) { seen.add(b); want.delete(b); st.push(b); }
      }
    }
    return want.size === 0;
  };
  Optimizer.prototype.step = function (iters, temp) {
    const m = this.m, plan = this.plan, r = this.r;
    let accepted = 0;
    for (let it = 0; it < iters; it++) {
      const u = (r() * m.n) | 0, a = plan[u];
      if (a < 0) continue;
      const s0 = m.nbStart[u], s1 = m.nbStart[u + 1];
      if (s1 === s0) continue;
      const v = m.nb[s0 + ((r() * (s1 - s0)) | 0)], b = plan[v];
      if (b < 0 || b === a) continue;
      if (this.lock && m.boro[u] !== m.boro[v]) continue;
      if (this.agg.cnt[a] <= 1) continue;
      if (!this._staysConnected(u, a)) continue;
      const pinned = this.pin[u];
      const aff = [a, b];
      if (pinned && m.out[u]) for (const o of m.out[u]) if (o.admin < this.K && aff.indexOf(o.admin) < 0) aff.push(o.admin);
      const old = aff.map((d) => this.terms[d]);
      this._add(u, a, -1, pinned); plan[u] = b; this._add(u, b, 1, 0);
      const nw = aff.map((d) => this._term(d));
      const S = this.sums.slice();
      for (let j = 0; j < aff.length; j++) for (let k = 0; k < 6; k++) S[k] += nw[j][k] - old[j][k];
      const sc = this._score(S), delta = sc - this.score;
      if (delta <= 0 || (temp > 0 && r() < Math.exp(-delta / temp))) {
        aff.forEach((d, j) => (this.terms[d] = nw[j])); this.sums = S; this.score = sc; this.pin[u] = 0; accepted++;
      } else {
        this._add(u, b, -1, 0); plan[u] = a; this._add(u, a, 1, pinned);
      }
    }
    this.iter += iters;
    return accepted;
  };
  // run a full annealing schedule synchronously (Node / presets)
  Optimizer.prototype.anneal = function (total, t0, t1) {
    const chunks = 200, per = Math.ceil(total / chunks);
    for (let c = 0; c < chunks; c++) {
      const t = t0 * Math.pow(t1 / t0, c / (chunks - 1));
      this.step(per, t);
    }
    this.step(per * 5, 0);
    return this.score;
  };

  // ---------- seed plans ----------
  function seedPlan(m, K, seed, lock) {
    // per-borough weighted k-means on unit coordinates, then contiguity repair
    const r = rng(seed);
    const plan = new Int16Array(m.n).fill(-1);
    const seats = lock ? apportion(m, K) : null;
    const groups = lock ? [0, 1, 2, 3, 4].map((b) => ({ b, k: seats[b] })) : [{ b: -1, k: K }];
    let next = 0;
    for (const { b, k } of groups) {
      const ids = []; for (let i = 0; i < m.n; i++) if (b < 0 || m.boro[i] === b) ids.push(i);
      const w = ids.map((i) => m.E[i] + 1);
      // k-means++ init
      const C = [];
      const pick = (weights) => { let s = weights.reduce((a, c) => a + c, 0) * r(); for (let j = 0; j < weights.length; j++) { s -= weights[j]; if (s <= 0) return j; } return weights.length - 1; };
      C.push(ids[pick(w)]);
      while (C.length < k) {
        const dw = ids.map((i, j) => { let best = Infinity; for (const c of C) { const dx = m.x[i] - m.x[c], dy = m.y[i] - m.y[c]; best = Math.min(best, dx * dx + dy * dy); } return best * w[j]; });
        C.push(ids[pick(dw)]);
      }
      let cx = C.map((c) => m.x[c]), cy = C.map((c) => m.y[c]);
      const lab = new Int32Array(ids.length);
      const cap = ids.reduce((s, i) => s + m.E[i], 0) / k;
      for (let iter = 0; iter < 30; iter++) {
        // capacity-aware assignment: penalize overfull centers
        const load = new Float64Array(k);
        const order = ids.map((_, j) => j).sort(() => r() - 0.5);
        for (const j of order) {
          const i = ids[j]; let best = 0, bd = Infinity;
          for (let c = 0; c < k; c++) {
            const dx = m.x[i] - cx[c], dy = m.y[i] - cy[c];
            const dd = Math.sqrt(dx * dx + dy * dy) * (1 + Math.max(0, load[c] / cap - 0.9) * 3);
            if (dd < bd) { bd = dd; best = c; }
          }
          lab[j] = best; load[best] += m.E[i];
        }
        const sx = new Float64Array(k), sy = new Float64Array(k), sw = new Float64Array(k);
        ids.forEach((i, j) => { const ww = w[j]; sx[lab[j]] += m.x[i] * ww; sy[lab[j]] += m.y[i] * ww; sw[lab[j]] += ww; });
        for (let c = 0; c < k; c++) if (sw[c]) { cx[c] = sx[c] / sw[c]; cy[c] = sy[c] / sw[c]; }
      }
      ids.forEach((i, j) => (plan[i] = next + lab[j]));
      next += k;
    }
    repair(m, plan, K);
    return plan;
  }
  function repair(m, plan, K) {
    // keep the largest component of each district; reassign orphans to adjacent districts
    for (let pass = 0; pass < 20; pass++) {
      let changed = false;
      for (let d = 0; d < K; d++) {
        const seen = new Uint8Array(m.n); const comps = [];
        for (let i = 0; i < m.n; i++) {
          if (plan[i] !== d || seen[i]) continue;
          const c = [i]; seen[i] = 1;
          for (let q = 0; q < c.length; q++) { const a = c[q]; for (let k = m.nbStart[a]; k < m.nbStart[a + 1]; k++) { const b = m.nb[k]; if (plan[b] === d && !seen[b]) { seen[b] = 1; c.push(b); } } }
          comps.push(c);
        }
        if (comps.length <= 1) continue;
        comps.sort((a, b) => b.length - a.length);
        for (const c of comps.slice(1)) for (const i of c) plan[i] = -2;
        changed = true;
      }
      // fill -2 from neighbors (same borough first)
      let left = true;
      while (left) {
        left = false; let progress = false;
        for (let i = 0; i < m.n; i++) {
          if (plan[i] !== -2) continue;
          let best = -1;
          for (let k = m.nbStart[i]; k < m.nbStart[i + 1]; k++) { const b = m.nb[k]; if (plan[b] >= 0 && (best < 0 || m.boro[b] === m.boro[i])) best = plan[b]; }
          if (best >= 0) { plan[i] = best; progress = true; } else left = true;
        }
        if (!progress) break;
      }
      if (!changed) break;
    }
  }
  // relabel plan districts so they line up with current district numbers where possible
  function relabelToCurrent(m, plan, K) {
    const ov = Array.from({ length: K }, () => new Float64Array(K));
    for (let i = 0; i < m.n; i++) if (plan[i] >= 0 && m.cur[i] >= 0 && m.cur[i] < K) ov[plan[i]][m.cur[i]] += m.E[i] + 1;
    const pairs = [];
    for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) pairs.push([ov[a][b], a, b]);
    pairs.sort((x, y) => y[0] - x[0]);
    const map = new Int16Array(K).fill(-1), usedB = new Uint8Array(K);
    for (const [, a, b] of pairs) if (map[a] < 0 && !usedB[b]) { map[a] = b; usedB[b] = 1; }
    for (let a = 0, b = 0; a < K; a++) if (map[a] < 0) { while (usedB[b]) b++; map[a] = b; usedB[b] = 1; }
    for (let i = 0; i < m.n; i++) if (plan[i] >= 0) plan[i] = map[plan[i]];
    return plan;
  }
  function currentPlan(m) { return Int16Array.from(m.cur); }

  // compact encoding for URLs / files
  const ALPH = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
  function encodePlan(plan) { let s = ""; for (const d of plan) s += d < 0 ? "." : ALPH[d]; return s; }
  function decodePlan(s, n) {
    const p = new Int16Array(n).fill(-1);
    for (let i = 0; i < Math.min(n, s.length); i++) p[i] = s[i] === "." ? -1 : ALPH.indexOf(s[i]);
    return p;
  }

  const Engine = { BOROS, BORO_NAMES, GROUPS, NG, rng, buildModel, stats, Optimizer, seedPlan, repair, relabelToCurrent, currentPlan, apportion, targets, districtBoros, encodePlan, decodePlan };
  if (typeof module !== "undefined" && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof window !== "undefined" ? window : globalThis);
