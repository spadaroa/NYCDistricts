// Generates src/presets.json using the same engine the browser uses.
const E = require('../src/engine.js'); const data = require('../src/data.json'); const fs = require('fs');
const m = E.buildModel(data, 'C'); const K = 32;
const AD = data.meta.fields.indexOf('admin');
// zones holding a school that reports to another district (any school type)
const OUT = data.units.map((u, i) => (u.s.some((si) => data.schools[si][AD] && data.schools[si][AD] !== u.cur) ? i : -1)).filter((i) => i >= 0);
const P = [
  { id: 'current', name: 'Current districts (2025–26)', desc: "The 32 community school districts as they exist today. Note how unequal they are in size: the largest has several times the enrollment of the smallest. Zones follow DOE elementary school zones. Schools located outside their own district (like Beacon High School, District 3, located in District 2) are counted in the district they report to.", weights: null },
  { id: 'equal', name: 'Equal size, compact', desc: 'Redrawn from scratch: every district within 5% of its borough\'s ideal enrollment, shapes as compact as possible. Seats are re-apportioned to boroughs by enrollment.', weights: { pop: 0.5, compact: 3 } },
  { id: 'econ', name: 'Economic balance', desc: 'Equal size, but optimized so each district\'s share of students in poverty is as close to the citywide rate as geography allows.', weights: { pop: 0.2, compact: 0.5, econ: 5 } },
  { id: 'race', name: 'Racial/ethnic integration', desc: 'Equal size, optimized so each district\'s racial/ethnic mix mirrors the city (minimizes the Theil segregation index).', weights: { pop: 0.2, compact: 0.5, race: 5 } },
  { id: 'blend', name: 'Balanced blend', desc: 'A middle path: equal size, reasonably compact, with moderate weight on both economic and racial/ethnic balance.', weights: { pop: 0.3, compact: 1, econ: 3, race: 3 } },
  { id: 'minchange', name: 'Fix sizes, minimal change', desc: 'Starts from today\'s map and keeps each borough\'s current number of districts, moving as few students as possible to bring each district close to its borough average: within 5% everywhere except Manhattan, where single zones hold up to 1,900 students and the closest fit is 8%.', weights: { pop: 0.3, compact: 0.3, change: 5 }, fromCurrent: true },
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
fs.writeFileSync(__dirname + '/../src/presets.json', JSON.stringify(out));
