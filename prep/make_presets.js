// Generates src/presets.json using the same engine the browser uses.
const E = require('../src/engine.js'); const LAYER = process.argv[2] || 'es'; const data = require(`../src/data_${LAYER}.json`); const fs = require('fs');
const m = E.buildModel(data, 'C'); const K = 32;
const AD = data.meta.fields.indexOf('admin');
// zones holding a school that reports to another district (any school type)
const OUT = data.units.map((u, i) => (u.s.some((si) => data.schools[si][AD] && data.schools[si][AD] !== u.cur) ? i : -1)).filter((i) => i >= 0);
const AIM = 'Each district aims to be within 5% of its borough\'s average size; larger building blocks may not get there, so check the scorecard.';
const P = [
  { id: 'current', name: 'Today\'s districts (2025–26)', desc: "The 32 community school districts as they exist today. They are very unequal in size: the largest has several times the enrollment of the smallest. Schools located outside their own district (like Beacon High School, District 3, located in District 2) are counted in the district they report to.", weights: null },
  { id: 'equal', name: 'Example: equal size, compact', desc: 'A computer-generated example, redrawn from scratch with shapes as compact as possible and seats re-apportioned to boroughs by enrollment. ' + AIM, weights: { pop: 0.5, compact: 3 } },
  { id: 'econ', name: 'Example: economic balance', desc: 'A computer-generated example that brings each district\'s share of students in poverty as close to the citywide rate as geography allows. ' + AIM, weights: { pop: 0.2, compact: 0.5, econ: 5 } },
  { id: 'race', name: 'Example: racial/ethnic integration', desc: 'A computer-generated example that brings each district\'s racial/ethnic mix as close to the city\'s as geography allows (minimizes Theil\'s H). ' + AIM, weights: { pop: 0.2, compact: 0.5, race: 5 } },
  { id: 'blend', name: 'Example: balanced blend', desc: 'A computer-generated middle path: reasonably compact, with moderate weight on both economic and racial/ethnic balance. ' + AIM, weights: { pop: 0.3, compact: 1, econ: 3, race: 3 } },
  { id: 'minchange', name: 'Example: fix sizes, minimal change', desc: 'A computer-generated example that starts from today\'s map, keeps each borough\'s current number of districts, and moves as few students as possible toward equal size. ' + AIM, weights: { pop: 0.3, compact: 0.3, change: 5 }, fromCurrent: true },
];
const out = [];
for (const p of P) {
  let plan, pin = new Uint8Array(m.n);
  if (!p.weights) { plan = E.currentPlan(m); pin.fill(1); }
  else {
    let best = null;
    for (const seed of [3, 7, 19, 23, 41]) {
      const pl = p.fromCurrent ? E.currentPlan(m) : E.seedPlan(m, K, seed, true);
      const pn = new Uint8Array(m.n).fill(p.fromCurrent ? 1 : 0);
      const o = new E.Optimizer(m, pl, K, { weights: p.weights, seed: seed * 13, maxDev: 0.05, lock: true, pin: pn });
      const sc = o.anneal(3000000, 2, 0.003);
      if (!best || sc < best.sc) best = { sc, pl, pn };
    }
    plan = p.fromCurrent ? best.pl : E.relabelToCurrent(m, best.pl, K); pin = best.pn;
  }
  const s = E.stats(m, plan, K, { pin }).summary;
  console.log(p.id.padEnd(10), 'maxDev', s.maxDev.toFixed(3), 'PP', s.avgPP.toFixed(3), 'H', s.theilH.toFixed(3), 'Dpov', s.dissimPov.toFixed(3), 'changed', s.changed.toFixed(3), 'noncontig', s.nonContig);
  out.push({ id: p.id, name: p.name, desc: p.desc, K, mode: 'C', weights: p.weights, plan: E.encodePlan(plan), pins: OUT.filter((i) => pin[i]) });
}
fs.writeFileSync(__dirname + `/../src/presets_${LAYER}.json`, JSON.stringify(out));
