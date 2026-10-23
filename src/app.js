(function () {
  "use strict";
  const E = window.Engine, DATA = window.DATA, PRESETS = window.PRESETS;
  const $ = (id) => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const F = {}; DATA.meta.fields.forEach((f, i) => (F[f] = i));
  const N = DATA.units.length;
  const LAYER = window.LAYER || "es";
  const STORE = "nycsdb.v4." + LAYER;
  const GROUP_ORDER = ["C", "H", "S", "R"];
  const GROUP_COLORS = { C: "#2f6fd6", H: "#d9480f", S: "#7b3fbf", A: "#2b8a3e", R: "#c2255c" };

  // ---------- state ----------
  const S = {
    mode: "C", K: 32, dots: false, lines: false, level: "zone", lock: true, plan: null, presetId: "current",
    active: 0, tool: "pan", brush: 1, colorBy: "district",
    pin: new Uint8Array(0), undo: [], redo: [], model: null, base: null, stats: null, sort: { key: "d", dir: 1 },
  };

  // ---------- colors ----------
  const isDark = () => {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "dark";
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
  };
  function districtColor(d) {
    if (d < 0) return isDark() ? "#26313d" : "#cfd6de";
    const h = (d * 137.508 + 20) % 360;
    const l = isDark() ? (d % 2 ? 44 : 54) : (d % 2 ? 62 : 74);
    const s = d % 3 === 0 ? 62 : 52;
    return `hsl(${h.toFixed(0)} ${s}% ${l}%)`;
  }
  function seq(t) { // sequential: pale to deep blue-green
    t = Math.max(0, Math.min(1, t));
    const a = isDark() ? [36, 48, 60] : [236, 242, 238], b = isDark() ? [120, 220, 200] : [10, 90, 110];
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
  }
  function div(t) { // diverging around 0: blue (under) / orange (over), t in [-1,1]
    t = Math.max(-1, Math.min(1, t));
    const mid = isDark() ? [60, 68, 78] : [240, 240, 240];
    const lo = [40, 110, 200], hi = [220, 110, 30];
    const e = t < 0 ? lo : hi, k = Math.abs(t);
    return `rgb(${mid.map((v, i) => Math.round(v + (e[i] - v) * k)).join(",")})`;
  }
  const COLOR_DEFS = {
    asian: { label: "% Asian" }, black: { label: "% Black" }, hisp: { label: "% Hispanic" }, white: { label: "% White" },
    multi: { label: "% Multiracial" }, native: { label: "% Native American" }, ell: { label: "% ELL / ENL" },
    swd: { label: "% Students with disabilities" }, pov: { label: "% In poverty" }, eni: { label: "Economic Need Index" },
    devCity: { label: "Enrollment vs. citywide average", lo: -0.5, hi: 0.5 },
    dev: { label: "Enrollment vs. borough average", lo: -0.5, hi: 0.5 },
  };
  const GI = { asian: 0, black: 1, hisp: 2, white: 3, multi: 4 };
  function pct0(v) { return Math.round(v * 100) + "%"; }
  function pct1(v) { return (v * 100).toFixed(1) + "%"; }
  const fmtN = (v) => Math.round(v).toLocaleString("en-US");
  const SHORT = { C: "community supt.", H: "HS supt.", S: "D75", R: "charter" };
  function countShort() {
    const g = S.mode.split("");
    if (g.length === 4) return "students (all school types)";
    return (g.length === 1 ? SHORT[g[0]] : g.map((x) => SHORT[x]).join(" + ")) + " students";
  }
  function countLong() {
    const names = S.mode.split("").map((g) => DATA.meta.groups[g].toLowerCase() + " schools");
    return names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0];
  }

  // ---------- map ----------
  const svg = $("map");
  const gCells = document.createElementNS(SVGNS, "g"), gEdges = document.createElementNS(SVGNS, "g");
  const gCoast = document.createElementNS(SVGNS, "g"), gLabels = document.createElementNS(SVGNS, "g");
  const hoverPath = document.createElementNS(SVGNS, "path"); hoverPath.setAttribute("class", "hover");
  const gOfficial = document.createElementNS(SVGNS, "g"), gDots = document.createElementNS(SVGNS, "g");
  svg.append(gCells, gCoast, gEdges, gOfficial, gLabels, gDots, hoverPath);
  const ringD = (r) => { let s = "M" + r[0] + " " + r[1]; for (let k = 2; k < r.length; k += 2) s += "L" + r[k] + " " + r[k + 1]; return s + "Z"; };
  const lineD = (r) => { let s = "M" + r[0] + " " + r[1]; for (let k = 2; k < r.length; k += 2) s += "L" + r[k] + " " + r[k + 1]; return s; };
  const cellEls = [], cellD = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  DATA.units.forEach((u, i) => {
    const d = u.poly.map(ringD).join("");
    cellD.push(d);
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d); p.setAttribute("class", "cell"); p.dataset.i = i;
    gCells.appendChild(p); cellEls.push(p);
    for (const r of u.poly) for (let k = 0; k < r.length; k += 2) { minX = Math.min(minX, r[k]); maxX = Math.max(maxX, r[k]); minY = Math.min(minY, r[k + 1]); maxY = Math.max(maxY, r[k + 1]); }
  });
  const unitEdges = Array.from({ length: N }, () => []);
  const edgeEls = DATA.edges.map(([a, b, lines], k) => {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", lines.map(lineD).join("")); p.setAttribute("class", "edge");
    gEdges.appendChild(p); unitEdges[a].push(k); unitEdges[b].push(k);
    return p;
  });
  for (const dn in DATA.districts) {
    const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", DATA.districts[dn].map(ringD).join("")); p.setAttribute("class", "official"); gOfficial.appendChild(p);
  }
  gOfficial.style.display = "none";
  // school dots
  const dotEls = DATA.schools.map((s, si) => {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", s[F.x]); c.setAttribute("cy", s[F.y]); c.setAttribute("class", "dot"); c.dataset.s = si;
    c.style.fill = GROUP_COLORS[s[F.grp]] || "#888"; gDots.appendChild(c); return c;
  });
  gDots.style.display = "none";
  function sizeDots() {
    if (!S.dots) return;
    const s = Math.max(view.w / Math.max(1, svg.clientWidth), view.h / Math.max(1, svg.clientHeight));
    DATA.schools.forEach((sc, si) => dotEls[si].setAttribute("r", ((1.6 + Math.sqrt(sc[F.n]) * 0.075) * s).toFixed(1)));
  }
  function styleDots() {
    DATA.schools.forEach((sc, si) => dotEls[si].classList.toggle("off", S.mode.indexOf(sc[F.grp]) < 0));
  }
  const full = { x: minX - 800, y: minY - 800, w: maxX - minX + 1600, h: maxY - minY + 1600 };
  let view = Object.assign({}, full);
  function setView(v) {
    view = v; svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    const fs = Math.max(v.w / svg.clientWidth, v.h / svg.clientHeight) * 15;
    gLabels.setAttribute("font-size", fs.toFixed(0));
    if (S.dots) { cancelAnimationFrame(sizeDots.raf); sizeDots.raf = requestAnimationFrame(sizeDots); }
  }
  function fit() {
    const r = svg.getBoundingClientRect(); const ar = r.width / Math.max(1, r.height);
    let w = full.w, h = full.h; if (w / h < ar) w = h * ar; else h = w / ar;
    setView({ x: full.x - (w - full.w) / 2, y: full.y - (h - full.h) / 2, w, h });
  }
  function toWorld(cx, cy) {
    const r = svg.getBoundingClientRect();
    const s = Math.max(view.w / r.width, view.h / r.height);
    const ox = view.x + view.w / 2 - (r.width * s) / 2, oy = view.y + view.h / 2 - (r.height * s) / 2;
    return [ox + (cx - r.left) * s, oy + (cy - r.top) * s, s];
  }
  function zoomAt(cx, cy, f) {
    const [wx, wy] = toWorld(cx, cy);
    const w = Math.min(full.w * 3, Math.max(800, view.w * f)), k = w / view.w;
    setView({ x: wx - (wx - view.x) * k, y: wy - (wy - view.y) * k, w, h: view.h * k });
  }

  // ---------- model / stats ----------
  function rebuildModel() {
    S.model = E.buildModel(DATA, S.mode);
    S.base = E.stats(S.model, E.currentPlan(S.model), 32, { lock: true, pin: new Uint8Array(N).fill(1) });
    styleDots();
  }
  function recompute() {
    if (S.active >= S.K) S.active = 0;
    S.stats = E.stats(S.model, S.plan, S.K, { lock: S.lock, pin: S.pin });
    $("cityPov").textContent = pct0(S.stats.summary.Ppov);
    $("countLine").innerHTML = `Counting <b>${fmtN(S.stats.summary.totE)} students</b> in ${countLong()} only.`;
    renderColors(); renderLabels(); renderScore(); renderSwatches(); renderTable(); renderBrush(); renderTopline(); renderCode(); save();
  }
  let rq = 0;
  function recomputeSoon() { if (rq) return; rq = requestAnimationFrame(() => { rq = 0; recompute(); }); }

  function unitValue(i, key) {
    const m = S.model, e = m.E[i];
    if (!e) return null;
    if (key === "pov") return m.pov[i] / e; if (key === "eni") return m.eniW[i] / e;
    if (key === "ell") return m.ell[i] / e; if (key === "swd") return m.swd[i] / e;
    if (key === "native") return m.native[i] / e;
    if (key in GI) return m.G[GI[key]][i] / e;
    return null;
  }
  function districtValue(s, key) {
    if (!s || s.empty) return null;
    if (key === "pov") return s.povPct; if (key === "eni") return s.eni; if (key === "ell") return s.ellPct; if (key === "swd") return s.swdPct;
    if (key === "native") return s.nativePct; if (key === "dev") return s.dev; if (key === "devCity") return s.devCity;
    if (key === "raceH") return s.raceH; if (key === "econH") return s.econH;
    if (key === "raceVs") return s.raceVs; if (key === "econVs") return s.econVs;
    if (key in GI) return s.pct[GI[key]];
    return null;
  }
  // heat scale: 0 to the 95th percentile of the values being shown (rounded up to 5 points)
  function scaleFor(key, vals) {
    if (key === "dev" || key === "devCity") return { lo: -0.5, hi: 0.5 };
    const v = vals.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return { lo: 0, hi: 1 };
    let hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
    hi = Math.min(1, Math.max(0.05, Math.ceil(hi * 20) / 20));
    const lo = key === "eni" || key === "pov" ? Math.max(0, Math.floor(v[Math.floor(v.length * 0.05)] * 20) / 20) : 0;
    return { lo, hi };
  }
  function renderColors() {
    const key = S.colorBy, D = S.stats.districts;
    const isDev = key === "dev" || key === "devCity";
    const zone = S.level === "zone" && !isDev;
    const vals = key === "district" ? [] : Array.from({ length: N }, (_, i) => (zone ? unitValue(i, key) : S.plan[i] >= 0 ? districtValue(D[S.plan[i]], key) : null));
    const sc = key === "district" ? null : scaleFor(key, zone ? vals : D.filter((x) => !x.empty).map((x) => districtValue(x, key)));
    for (let i = 0; i < N; i++) {
      const d = S.plan[i];
      let c;
      if (key === "district") c = districtColor(d);
      else {
        const v = vals[i];
        if (v == null) c = districtColor(-1);
        else if (isDev) c = div(v / sc.hi);
        else c = seq((v - sc.lo) / (sc.hi - sc.lo));
      }
      cellEls[i].style.fill = c;
    }
    S.scale = sc;
    renderEdges();
    renderLegend();
  }
  function renderEdges() {
    DATA.edges.forEach(([a, b], k) => {
      const pa = S.plan[a], pb = S.plan[b];
      const border = pa !== pb;
      const act = border && (pa === S.active || pb === S.active) && S.colorBy === "district";
      edgeEls[k].setAttribute("class", "edge" + (border ? (act ? " ab" : " b") : ""));
    });
  }
  function renderLegend() {
    const L = $("legend");
    if (S.colorBy === "district") { L.hidden = true; return; }
    const def = COLOR_DEFS[S.colorBy], sc = S.scale; L.hidden = false;
    const f = S.colorBy === "eni" ? (v) => v.toFixed(2) : (v) => ((S.colorBy === "dev" || S.colorBy === "devCity") && v > 0 ? "+" : "") + pct0(v);
    const stops = [];
    for (let k = 0; k <= 10; k++) stops.push((S.colorBy === "dev" || S.colorBy === "devCity") ? div((k / 10) * 2 - 1) : seq(k / 10));
    const lvl = S.level === "zone" && !(S.colorBy === "dev" || S.colorBy === "devCity") ? "each zone" : "district average";
    L.innerHTML = `<div><b>${def.label}</b> · ${lvl}</div><div class="bar" style="background:linear-gradient(90deg,${stops.join(",")})"></div><div class="ends"><span>${f(sc.lo)}${(S.colorBy === "dev" || S.colorBy === "devCity") ? " under" : ""}</span><span>${f(sc.hi)}${(S.colorBy === "dev" || S.colorBy === "devCity") ? " over" : "+"}</span></div>` +
      (S.level === "zone" && !(S.colorBy === "dev" || S.colorBy === "devCity") ? `<div class="ends" style="margin-top:2px"><span>Gray: no counted students</span></div>` : "");
  }
  function renderLabels() {
    gLabels.textContent = "";
    for (const s of S.stats.districts) {
      if (s.empty) continue;
      // place label on the district's building nearest its center
      let best = -1, bd = Infinity;
      for (let i = 0; i < N; i++) if (S.plan[i] === s.d) { const dx = S.model.x[i] - s.cx, dy = S.model.y[i] - s.cy, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = i; } }
      if (best < 0) continue;
      const t = document.createElementNS(SVGNS, "text");
      t.setAttribute("x", S.model.x[best]); t.setAttribute("y", S.model.y[best]); t.setAttribute("class", "lbl");
      t.textContent = s.d + 1; gLabels.appendChild(t);
    }
  }

  // ---------- panel ----------
  function chip(delta, goodWhenLower, fmt, tol) {
    if (Math.abs(delta) < (tol || 1e-9)) return `<span class="pill neutral">same</span>`;
    const good = goodWhenLower ? delta < 0 : delta > 0;
    return `<span class="pill ${good ? "good" : "bad"}">${delta > 0 ? "+" : "−"}${fmt(Math.abs(delta))}</span>`;
  }
  function renderScore() {
    const s = S.stats.summary, b = S.base.summary;
    const pts = (v) => (v * 100).toFixed(1);
    const rows = [
      ["Largest gap from citywide average", `Average district: ${fmtN(s.cityAvg)} ${countShort()}`, "±" + pct0(s.maxDevCity), chip(s.maxDevCity - b.maxDevCity, true, (v) => Math.round(v * 100) + " pts", 0.005)],
      ...(S.lock ? [["Largest gap within a borough", "Compared with the average district in the same borough", "±" + pct0(s.maxDev), chip(s.maxDev - b.maxDev, true, (v) => Math.round(v * 100) + " pts", 0.005)]] : []),
      ["Compactness", "Average Polsby-Popper, higher is rounder", s.avgPP.toFixed(2), chip(s.avgPP - b.avgPP, false, (v) => v.toFixed(2), 0.005)],
      ["Racial/ethnic segregation", "Theil's H, lower is more integrated", s.theilH.toFixed(3), chip(s.theilH - b.theilH, true, (v) => v.toFixed(3), 0.0005)],
      ["Economic segregation", "Theil's H for poverty, lower is more even", s.theilEcon.toFixed(3), chip(s.theilEcon - b.theilEcon, true, (v) => v.toFixed(3), 0.0005)],
      ["Students moved", "Counted students whose school would be in a different district than today", pct0(s.changed), ""],
      ["Districts in pieces", "Zones not connected to the rest of their district", String(s.nonContig), s.nonContig ? `<span class="pill bad">fix</span>` : `<span class="pill good">none</span>`],
      ["Unassigned buildings", s.unassigned ? `${fmtN(s.unassignedE)} students not in any district` : "Every building is in a district", String(s.unassigned), s.unassigned ? `<span class="pill warn">${s.unassigned}</span>` : `<span class="pill good">none</span>`],
    ];
    if (S.lock && s.crossBoro) rows.splice(5, 0, ["Districts crossing boroughs", "Allowed only when the borough rule is off", String(s.crossBoro), `<span class="pill warn">check</span>`]);
    $("score").innerHTML = rows.map(([k, sub, v, c]) => `<div class="sr"><span class="k">${k}<small>${sub}</small></span><span class="v">${v}</span><span class="c">${c}</span></div>`).join("");
    void pts;
  }
  function renderSwatches() {
    const el = $("swatches"); const D = S.stats.districts;
    if (el.childElementCount !== S.K) {
      el.innerHTML = "";
      for (let d = 0; d < S.K; d++) {
        const b = document.createElement("button"); b.dataset.d = d; b.innerHTML = `${d + 1}<span class="d"></span>`;
        b.addEventListener("click", () => setActive(d)); el.appendChild(b);
      }
    }
    [...el.children].forEach((b, d) => {
      b.style.background = districtColor(d);
      b.setAttribute("aria-pressed", d === S.active ? "true" : "false");
      const s = D[d]; const bar = b.querySelector(".d");
      const dev = s && !s.empty ? s.devCity : -1;
      bar.style.background = Math.abs(dev) <= 0.05 ? "var(--good)" : Math.abs(dev) <= 0.15 ? "var(--warn)" : "var(--bad)";
      b.title = s && !s.empty ? `District ${d + 1}: ${fmtN(s.E)} ${countShort()} (${dev > 0 ? "+" : ""}${pct0(dev)} vs. citywide average)` : `District ${d + 1}: empty`;
    });
  }
  const COLS = [
    ["d", "Dist"], ["boro", "Boro"], ["E", "Students"], ["devCity", "vs city avg"], ["dev", "vs boro avg"], ["asian", "Asian"], ["black", "Black"], ["hisp", "Hisp."], ["white", "White"], ["multi", "Multi"],
    ["pov", "Poverty"], ["eni", "ENI"], ["ell", "ELL"], ["swd", "SWD"], ["raceH", "Race H"], ["econH", "Econ H"], ["raceVs", "Race vs city"], ["econVs", "Econ vs city"], ["ns", "Schools"], ["pp", "Compact"],
  ];
  function renderTable() {
    const D = S.stats.districts.filter((s) => !s.empty);
    const cols = COLS.filter(([k]) => k !== "dev" || S.lock);
    const val = (s, k) => k === "d" ? s.d : k === "boro" ? s.boro : k === "E" ? s.E : k === "ns" ? s.ns : k === "pp" ? s.pp : districtValue(s, k);
    D.sort((a, b) => (val(a, S.sort.key) - val(b, S.sort.key)) * S.sort.dir);
    const cell = (s, k) => {
      const v = val(s, k);
      if (k === "d") return `<span class="sw" style="background:${districtColor(s.d)}"></span>${s.d + 1}${s.comps > 1 ? ' <span class="bad-t" title="In pieces">⚠</span>' : ""}`;
      if (k === "boro") return E.BOROS[s.boro] || "–";
      if (k === "E" || k === "ns") return fmtN(v);
      if (k === "raceH" || k === "econH" || k === "raceVs" || k === "econVs") return v.toFixed(3);
      if (k === "dev" || k === "devCity") return `<span class="${Math.abs(v) > 0.15 ? "bad-t" : Math.abs(v) > 0.05 ? "warn-t" : ""}">${v > 0 ? "+" : ""}${pct0(v)}</span>`;
      if (k === "pp") return v.toFixed(2);
      return pct0(v);
    };
    const b = S.stats.summary;
    const cityVal = { d: "<b>City</b>", E: fmtN(b.totE - b.unassignedE), devCity: `avg ${fmtN(b.cityAvg)}`,
      asian: pct0(b.Pg[0]), black: pct0(b.Pg[1]), hisp: pct0(b.Pg[2]), white: pct0(b.Pg[3]), multi: pct0(b.Pg[4]), pov: pct0(b.Ppov),
      raceH: `avg ${b.withinRace.toFixed(3)}`, econH: `avg ${b.withinEcon.toFixed(3)}`,
      raceVs: `<b>${b.theilH.toFixed(3)}</b>`, econVs: `<b>${b.theilEcon.toFixed(3)}</b>` };
    const cityRow = `<tr style="cursor:default">${cols.map(([k]) => `<td>${cityVal[k] || ""}</td>`).join("")}</tr>`;
    const tips = { devCity: "Difference from the average district citywide", dev: "Difference from the average district in the same borough",
      raceH: "Theil's H across the schools inside this district, by race/ethnicity: 0 = every school has the district's mix, 1 = each school serves one group",
      econH: "Theil's H across the schools inside this district, by poverty: 0 = every school has the district's poverty rate, 1 = complete separation",
      raceVs: "How far this district's racial/ethnic mix is from the city's (0 = same mix). City row = the plan's Theil's H, the weighted average of this column",
      econVs: "How far this district's poverty rate is from the city's (0 = same rate). City row = the plan's Theil's H, the weighted average of this column", E: countShort() };
    $("dtable").innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}"${tips[k] ? ` title="${tips[k]}"` : ""}>${l}${S.sort.key === k ? (S.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>${cityRow}${D.map((s) => `<tr data-d="${s.d}" class="${s.d === S.active ? "sel" : ""}">${cols.map(([k]) => `<td>${cell(s, k)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  }
  $("dtable").addEventListener("click", (e) => {
    const th = e.target.closest("th");
    if (th) { const k = th.dataset.k; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : 1 }; renderTable(); return; }
    const tr = e.target.closest("tr[data-d]"); if (tr) setActive(+tr.dataset.d);
  });
  function setActive(d) { S.active = d; if (S.tool !== "paint") setTool("paint"); renderSwatches(); renderTable(); renderEdges(); renderBrush(); renderTopline(); }
  function renderBrush() {
    $("brushSw").style.background = S.tool === "erase" ? "transparent" : districtColor(S.active);
    const s = S.stats && S.stats.districts[S.active];
    const what = S.tool === "erase" ? "Erasing" : S.tool === "pan" ? `Moving the map · press Paint (P) to draw with District ${S.active + 1}` : `District ${S.active + 1}`;
    const extra = S.tool === "paint" && s && !s.empty ? ` · ${fmtN(s.E)} ${countShort()} (${s.devCity > 0 ? "+" : ""}${pct0(s.devCity)} vs. citywide average)` : "";
    $("brushTxt").textContent = what + extra + (S.brush > 1 && S.tool !== "pan" ? " · wide brush" : "");
  }

  // ---------- topline window (floating over the map) ----------
  function topAgg(st) {
    const D = st.districts.filter((x) => !x.empty), n = D.length || 1;
    const E = D.reduce((a, x) => a + x.E, 0), ns = D.reduce((a, x) => a + x.ns, 0);
    const sum = st.summary;
    const med = (xs) => { if (!xs.length) return null; const v = xs.slice().sort((a, b) => a - b), h = v.length >> 1; return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2; };
    const avgE = D.length ? E / n : null;
    const sdE = D.length ? Math.sqrt(D.reduce((a, x) => a + (x.E - avgE) ** 2, 0) / n) : null;
    return { n: D.length, E, ns, avgE, avgNs: D.length ? ns / n : null,
      medE: med(D.map((x) => x.E)), medNs: med(D.map((x) => x.ns)), sdE,
      min: D.length ? Math.min(...D.map((x) => x.E)) : null, max: D.length ? Math.max(...D.map((x) => x.E)) : null,
      gap: sum.maxDevCity, race: sum.theilH, econ: sum.theilEcon, changed: sum.changed };
  }
  // dir: 1 = higher is better, -1 = lower is better, 0 = neither
  function tlRow(label, a, b, fmt, dfmt, dir, tol, title) {
    let dl = "–", cls = "";
    if (a != null && b != null) {
      const d = b - a;
      if (Math.abs(d) >= (tol || 1e-9)) { dl = (d > 0 ? "+" : "−") + dfmt(Math.abs(d)); if (dir) cls = (dir > 0 ? d > 0 : d < 0) ? " good" : " bad"; }
    }
    return `<tr${title ? ` title="${title}"` : ""}><td>${label}</td><td>${a == null ? "–" : fmt(a)}</td><td class="p">${b == null ? "–" : fmt(b)}</td><td class="dl${cls}">${dl}</td></tr>`;
  }
  const tlHead = (a, b) => `<thead><tr><th></th><th>${a}</th><th>${b}</th><th>Change</th></tr></thead>`;
  function renderTopline() {
    if (!S.stats || !S.base) return;
    const t = topAgg(S.base), p = topAgg(S.stats), n0 = (v) => fmtN(v), n1 = (v) => v.toFixed(1), h3 = (v) => v.toFixed(3);
    const pts = (v) => Math.round(v * 100) + " pts", pts1 = (v) => (v * 100).toFixed(1) + " pts";
    const city = [
      tlRow("Districts", t.n, p.n, n0, n0, 0),
      tlRow("Schools", t.ns, p.ns, n0, n0, 0, 0.5, "Counted schools placed in a district"),
      tlRow("Students", t.E, p.E, n0, n0, 0, 0.5, countShort() + " placed in a district"),
      tlRow("Size spread (std. dev.)", t.sdE, p.sdE, n0, n0, -1, 0.5, "How much district enrollments vary around the average; lower means more equal sizes"),
      tlRow("Smallest district", t.min, p.min, n0, n0, 0, 0.5, "Students in the smallest district"),
      tlRow("Largest district", t.max, p.max, n0, n0, 0, 0.5, "Students in the largest district"),
      tlRow("Max gap from avg", t.gap, p.gap, (v) => "±" + pct0(v), pts, -1, 0.005, "Biggest difference between any district and the average district citywide"),
      tlRow("Race segregation (H)", t.race, p.race, h3, h3, -1, 0.0005, "Theil's H across districts: 0 = every district matches the city mix"),
      tlRow("Econ segregation (H)", t.econ, p.econ, h3, h3, -1, 0.0005, "Theil's H for poverty across districts: 0 = every district has the city poverty rate"),
      `<tr title="Counted students whose school would be in a different district than today"><td>Students moved</td><td>–</td><td class="p">${pct0(p.changed)}</td><td class="dl">${p.changed > 0 ? fmtN(p.changed * S.stats.summary.totE) : "–"}</td></tr>`,
    ].join("");
    const d = S.active, a = d < 32 ? S.base.districts[d] : null, b = S.stats.districts[d];
    const A = a && !a.empty ? a : null, B = b && !b.empty ? b : null;
    const gv = (x, k) => (x ? districtValue(x, k) : null);
    const pr = (label, k, fmt, dfmt, tol) => tlRow(label, gv(A, k), gv(B, k), fmt, dfmt, 0, tol);
    const boro = (x) => (x && E.BORO_NAMES[E.BOROS[x.boro]]) || "–";
    const dist = A || B ? [
      tlRow("Students", A && A.E, B && B.E, n0, n0, 0, 0.5),
      tlRow("Schools", A && A.ns, B && B.ns, n0, n0, 0, 0.5),
      pr("vs. city avg", "devCity", (v) => (v > 0 ? "+" : "") + pct0(v), pts, 0.005),
      pr("Poverty", "pov", pct0, pts1, 0.0005),
      pr("ENI", "eni", (v) => v.toFixed(2), (v) => v.toFixed(2), 0.005),
      pr("ELL / ENL", "ell", pct0, pts1, 0.0005),
      pr("SWD", "swd", pct0, pts1, 0.0005),
      pr("Asian", "asian", pct0, pts1, 0.0005),
      pr("Black", "black", pct0, pts1, 0.0005),
      pr("Hispanic", "hisp", pct0, pts1, 0.0005),
      pr("White", "white", pct0, pts1, 0.0005),
    ].join("") : "";
    const where = B ? (A && A.boro !== B.boro ? `${boro(A)} → ${boro(B)}` : boro(B)) : "";
    $("toplineBody").innerHTML =
      `<h3>Citywide</h3><table>${tlHead("Today", "Plan")}<tbody>${city}</tbody></table>` +
      `<h3><span class="sw" style="background:${districtColor(d)}"></span>District ${d + 1}${where ? ` <span style="text-transform:none;letter-spacing:0;font-weight:400">· ${where}</span>` : ""}</h3>` +
      (dist ? `<table>${tlHead("Today", "Plan")}<tbody>${dist}</tbody></table>` : `<p class="note">District ${d + 1} has no buildings in today's map or this plan.</p>`) +
      (!B && A ? `<p class="note">District ${d + 1} has no buildings in this plan.</p>` : "") +
      `<p class="note">Follows the district you paint with. Counts ${countShort()}.</p>`;
  }
  {
    const tl = $("topline"); let open = null;
    try { open = localStorage.getItem("nycsdb.topline"); } catch (_) {}
    tl.open = open == null ? window.innerWidth > 860 : open === "1";
    tl.addEventListener("toggle", () => { try { localStorage.setItem("nycsdb.topline", tl.open ? "1" : "0"); } catch (_) {} });
  }

  // the district a school is counted in: its admin district while its zone is untouched, else its zone's district
  function schoolDistrict(si) {
    const s = DATA.schools[si], i = s[F.unit], ad = s[F.admin];
    if (S.plan[i] < 0) return -1;
    if (ad && ad !== DATA.units[i].cur && S.pin[i] && ad - 1 < S.K) return ad - 1;
    return S.plan[i];
  }
  // ---------- painting ----------
  let stroke = null;
  function applyAt(i) {
    const targets = [i];
    if (S.brush > 1) for (let k = S.model.nbStart[i]; k < S.model.nbStart[i + 1]; k++) if (S.model.boro[S.model.nb[k]] === S.model.boro[i]) targets.push(S.model.nb[k]);
    const to = S.tool === "erase" ? -1 : S.active;
    for (const u of targets) {
      if (S.plan[u] === to) continue;
      if (!stroke.has(u)) stroke.set(u, [S.plan[u], S.pin[u]]);
      S.plan[u] = to; S.pin[u] = 0;
    }
    recomputeSoon();
  }
  function endStroke() {
    if (stroke && stroke.size) { S.undo.push([...stroke.entries()].map(([u, [from, pin]]) => [u, from, S.plan[u], pin])); S.redo = []; if (S.undo.length > 200) S.undo.shift(); markEdited(); }
    stroke = null;
  }
  function undo(redo) {
    const from = redo ? S.redo : S.undo, to = redo ? S.undo : S.redo;
    const ch = from.pop(); if (!ch) return;
    for (const [u, a, b, p] of ch) { S.plan[u] = redo ? b : a; S.pin[u] = redo ? 0 : p; }
    to.push(ch); recompute();
  }
  function markEdited() {
    if (!S.presetId.startsWith("custom")) { S.presetId = "custom"; syncPresetSelect(); }
  }

  // pointer handling: paint, pan, pinch
  const pointers = new Map(); let panStart = null, pinch = null, spaceDown = false;
  function unitAt(x, y) { const el = document.elementFromPoint(x, y); return el && el.classList && el.classList.contains("cell") ? +el.dataset.i : -1; }
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
    $("tip").hidden = true;
    if (pointers.size === 2) { endStroke(); panStart = null; const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), view: Object.assign({}, view), cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 }; return; }
    if (S.tool === "pan" || spaceDown || e.button === 1 || e.button === 2) { panStart = { x: e.clientX, y: e.clientY, view: Object.assign({}, view) }; svg.style.cursor = "grabbing"; return; }
    abortOptimizer();
    stroke = new Map(); const i = unitAt(e.clientX, e.clientY); if (i >= 0) applyAt(i);
  });
  svg.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      setView(pinch.view); zoomAt(pinch.cx, pinch.cy, pinch.d / Math.max(10, d)); return;
    }
    if (panStart) {
      const [, , s] = toWorld(0, 0);
      setView({ ...panStart.view, x: panStart.view.x - (e.clientX - panStart.x) * s, y: panStart.view.y - (e.clientY - panStart.y) * s }); return;
    }
    if (stroke) { const i = unitAt(e.clientX, e.clientY); if (i >= 0) applyAt(i); return; }
    if (e.pointerType === "mouse") showTip(e);
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { panStart = null; svg.style.cursor = ""; endStroke(); recompute(); }
  };
  svg.addEventListener("pointerup", up); svg.addEventListener("pointercancel", up);
  svg.addEventListener("pointerleave", () => { $("tip").hidden = true; hoverPath.setAttribute("d", ""); });
  svg.addEventListener("contextmenu", (e) => e.preventDefault());
  svg.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0015)); }, { passive: false });

  const GROUP_SHORT = { C: "Community supt.", H: "HS supt.", S: "D75", A: "D79", R: "Charter" };
  function placeTip(e) {
    const tip = $("tip"); tip.hidden = false;
    const r = $("mapwrap").getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    if (x + 300 > r.width) x = Math.max(4, e.clientX - r.left - 310);
    if (y + tip.offsetHeight > r.height) y = Math.max(4, e.clientY - r.top - tip.offsetHeight - 10);
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function showTip(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY), tip = $("tip");
    if (el && el.classList && el.classList.contains("dot")) {
      const s = DATA.schools[+el.dataset.s], counted = S.mode.indexOf(s[F.grp]) >= 0, n = s[F.n] || 0;
      hoverPath.setAttribute("d", cellD[s[F.unit]]);
      const p = (k) => (n ? pct0(s[F[k]] / n) : "–");
      const sd = schoolDistrict(+el.dataset.s), zd = S.plan[s[F.unit]];
      const cross = s[F.admin] && s[F.admin] !== DATA.units[s[F.unit]].cur;
      tip.innerHTML = `<b>${s[F.name]}</b><div class="s">${s[F.dbn]} · ${DATA.meta.groups[s[F.grp]]}${counted ? "" : " (not counted)"}</div>` +
        `<div>Counted in ${sd >= 0 ? "District " + (sd + 1) : "no district"}${cross ? (sd !== zd ? ` · located in District ${zd + 1}'s zone; follows that zone once it is moved` : " · moved with its zone") : ""}</div>` +
        (s[F.sup] ? `<div class="s">Superintendent: ${s[F.sup]}${s[F.net] ? " · " + s[F.net].replace(/ Superintendent Office/i, "") : ""}</div>` : "") +
        `<div>${fmtN(n)} students · grades ${s[F.grades] || "–"}</div><div class="s">Asian ${p("asian")} · Black ${p("black")} · Hispanic ${p("hisp")} · White ${p("white")}</div><div class="s">ELL ${p("ell")} · SWD ${p("swd")} · Poverty ${p("pov")}</div>`;
      placeTip(e); return;
    }
    const i = el && el.classList && el.classList.contains("cell") ? +el.dataset.i : -1;
    if (i < 0) { tip.hidden = true; hoverPath.setAttribute("d", ""); return; }
    hoverPath.setAttribute("d", cellD[i]);
    const u = DATA.units[i], m = S.model, d = S.plan[i];
    const inc = new Set(m.schoolsIn[i]);
    const list = u.s.map((si) => { const s = DATA.schools[si]; return `<li${inc.has(si) ? "" : ' class="s"'}>${s[F.name]} <span class="s">${s[F.dbn]} · ${GROUP_SHORT[s[F.grp]]} · ${fmtN(s[F.n])}</span></li>`; }).slice(0, 8).join("");
    const more = u.s.length > 8 ? `<li class="s">+${u.s.length - 8} more</li>` : "";
    const e2 = m.E[i];
    const sups = [...new Set(u.s.map((si) => DATA.schools[si][F.sup]).filter(Boolean))];
    const outs = u.s.filter((si) => DATA.schools[si][F.admin] && DATA.schools[si][F.admin] !== u.cur);
    const where = outs.length ? `<div class="s">${outs.map((si) => `${DATA.schools[si][F.dbn]} reports to District ${DATA.schools[si][F.admin]}`).join("; ")}${S.pin[i] ? " and is counted there until this zone is moved" : "; it now moves with this zone"}.</div>` : "";
    tip.innerHTML = `<b>${d >= 0 ? "District " + (d + 1) : "Unassigned"}</b> <span class="s">· today District ${u.cur} · ${E.BORO_NAMES[u.b]}</span><div class="s">${u.id}${u.z ? " (" + u.z + ")" : ""}</div>` + where +
      (e2 ? `<div>${fmtN(e2)} ${countShort()} in this zone · ${pct0(m.pov[i] / e2)} poverty · ${pct0(m.ell[i] / e2)} ELL · ${pct0(m.swd[i] / e2)} SWD</div>` : `<div class="s">No ${countShort()} in this zone</div>`) +
      (sups.length ? `<div class="s">Superintendent${sups.length > 1 ? "s" : ""}: ${sups.join("; ")}</div>` : "") + `<ul>${list}${more}</ul>`;
    placeTip(e);
  }

  // ---------- tools ----------
  function setTool(t) {
    S.tool = t;
    $("tPaint").setAttribute("aria-pressed", t === "paint"); $("tErase").setAttribute("aria-pressed", t === "erase"); $("tPan").setAttribute("aria-pressed", t === "pan");
    svg.setAttribute("class", "tool-" + t); renderBrush();
  }
  $("tPaint").onclick = () => setTool("paint"); $("tErase").onclick = () => setTool("erase"); $("tPan").onclick = () => setTool("pan");
  $("tBrush").onclick = () => { S.brush = S.brush > 1 ? 1 : 2; $("tBrush").setAttribute("aria-pressed", S.brush > 1); renderBrush(); };
  $("tUndo").onclick = () => undo(false); $("tRedo").onclick = () => undo(true);
  const centerZoom = (f) => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); };
  $("tIn").onclick = () => centerZoom(0.7); $("tOut").onclick = () => centerZoom(1.4); $("tFit").onclick = fit;
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(e.shiftKey); return; }
    if (e.key === " ") { if (e.target.closest && e.target.closest("button, summary, a, [role=tab]")) return; spaceDown = true; e.preventDefault(); }
    const k = e.key.toLowerCase();
    if (k === "p") setTool("paint"); else if (k === "e") setTool("erase"); else if (k === "h") setTool("pan"); else if (k === "b") $("tBrush").click();
    else if (k === "]" || k === "arrowright") setActive((S.active + 1) % S.K); else if (k === "[" || k === "arrowleft") setActive((S.active + S.K - 1) % S.K);
  });
  document.addEventListener("keyup", (e) => { if (e.key === " ") spaceDown = false; });

  // tabs
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
    document.querySelectorAll(".pane").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
  }));

  $("colorBy").onchange = (e) => { S.colorBy = e.target.value; renderColors(); };
  document.querySelectorAll("#levelSeg button").forEach((b) => b.addEventListener("click", () => {
    S.level = b.dataset.level;
    document.querySelectorAll("#levelSeg button").forEach((x) => x.setAttribute("aria-checked", x === b));
    renderColors();
  }));
  $("showDots").onchange = (e) => { S.dots = e.target.checked; gDots.style.display = S.dots ? "" : "none"; $("dotkey").hidden = !S.dots; sizeDots(); };
  $("showLines").onchange = (e) => { S.lines = e.target.checked; gOfficial.style.display = S.lines ? "" : "none"; };
  $("dotkey").innerHTML = ["C", "H", "S", "R"].map((g) => `<span><span class="gdot" style="background:${GROUP_COLORS[g]}"></span>${GROUP_SHORT[g]}</span>`).join("") + `<span><span class="gdot" style="background:transparent;border:1.5px dashed var(--muted);box-shadow:none"></span>Not counted</span>`;
  // school group toggles
  const groupCount = {}; DATA.schools.forEach((s) => (groupCount[s[F.grp]] = (groupCount[s[F.grp]] || 0) + 1));
  const groupStu = {}; DATA.schools.forEach((s) => (groupStu[s[F.grp]] = (groupStu[s[F.grp]] || 0) + s[F.n]));
  function renderGroups() {
    $("groups").innerHTML = GROUP_ORDER.map((g) => `<label class="${S.mode.includes(g) ? "" : "off"}"><input type="checkbox" data-g="${g}" ${S.mode.includes(g) ? "checked" : ""}><span class="gdot" style="background:${GROUP_COLORS[g]}"></span><span>${DATA.meta.groups[g]} schools</span><span class="n">${fmtN(groupCount[g] || 0)} · ${fmtN(groupStu[g] || 0)} students</span></label>`).join("") +
      `<label class="off"><input type="checkbox" disabled><span class="gdot" style="background:${GROUP_COLORS.A}"></span><span>District 79 programs</span><span class="n">not in LCGMS</span></label>`;
    $("groupNote").textContent = S.mode === "C" ? "Today's community school districts are built around these schools." : "Charter and District 75 schools are placed in the district of the building they're in.";
  }
  $("groups").addEventListener("change", (e) => {
    const g = e.target.dataset.g; if (!g) return;
    let m = GROUP_ORDER.filter((x) => (x === g ? e.target.checked : S.mode.includes(x))).join("");
    if (!m) { toast("Count at least one group of schools."); e.target.checked = true; return; }
    abortOptimizer();
    S.mode = m; rebuildModel(); renderGroups(); recompute();
  });

  // ---------- presets ----------
  function syncPresetSelect() {
    const sel = $("presetSel");
    if (S.presetId === "custom" && !sel.querySelector('option[value="custom"]')) {
      const o = document.createElement("option"); o.value = "custom"; o.textContent = "Your plan (edited)"; sel.prepend(o);
    }
    sel.value = S.presetId;
    const p = PRESETS.find((x) => x.id === S.presetId);
    $("planName").textContent = p ? p.name : "Your plan";
    $("planDesc").textContent = p ? p.desc + (p.weights ? " Generated from community superintendent schools. It is one possible map, not a recommendation; edit it or pick another starting point." : "") : `${S.K} districts, edited by you. Use “Reset” or pick an example above to start over.`;
  }
  {
    const sel = $("presetSel"), og = document.createElement("optgroup"); og.label = "Generated examples";
    PRESETS.forEach((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; (p.id === "current" ? sel : og).appendChild(o); });
    sel.appendChild(og);
  }
  // Reset = start over with a fresh page: forget the saved map, building blocks, panel width and all settings.
  // It asks for a second click first, since it can't be undone.
  let resetArmed = 0;
  $("resetBtn").onclick = () => {
    const btn = $("resetBtn");
    if (!resetArmed) {
      btn.textContent = "Click again to reset"; btn.classList.add("armed");
      resetArmed = setTimeout(() => { resetArmed = 0; btn.textContent = "Reset"; btn.classList.remove("armed"); }, 4000);
      return;
    }
    clearTimeout(resetArmed); abortOptimizer();
    try { Object.keys(localStorage).filter((k) => k.startsWith("nycsdb")).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
    try { window.name = JSON.stringify({ nycsdbLayer: "es", fresh: true }); } catch (_) {}
    if (/^#plan=/.test(location.hash)) { try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {} }
    document.body.style.cursor = "progress";
    location.reload();
  };
  $("presetSel").onchange = (e) => { if (e.target.value === "custom") return; loadPreset(e.target.value); };
  function loadPreset(id) {
    const p = PRESETS.find((x) => x.id === id); if (!p) return;
    pushUndoAll();
    S.presetId = id; S.K = p.K; S.plan = E.decodePlan(p.plan, N);
    S.pin = new Uint8Array(N); for (const i of p.pins || []) S.pin[i] = 1;
    if (p.mode !== S.mode) { S.mode = p.mode; rebuildModel(); renderGroups(); }
    S.lock = true; $("lockBoro").checked = true;
    if (p.weights) for (const [k, el] of Object.entries(W)) { $(el).value = p.weights[k] || 0; }
    syncWeights(); syncPresetSelect(); recompute();
  }
  function pushUndoAll() {
    abortOptimizer();
    if (!S.plan) return;
    const prev = Int16Array.from(S.plan);
    S.undo.push({ whole: prev, pin: Uint8Array.from(S.pin), K: S.K, id: S.presetId, mode: S.mode, lock: S.lock });
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  // whole-plan undo entries
  const _undo = undo;
  undo = function (redo) { // eslint-disable-line no-func-assign
    const from = redo ? S.redo : S.undo, to = redo ? S.undo : S.redo;
    const top = from[from.length - 1];
    if (top && top.whole) {
      abortOptimizer();
      from.pop(); to.push({ whole: Int16Array.from(S.plan), pin: Uint8Array.from(S.pin), K: S.K, id: S.presetId, mode: S.mode, lock: S.lock });
      S.plan = top.whole; S.pin = top.pin; S.K = top.K; S.presetId = top.id;
      if (top.lock != null) { S.lock = top.lock; $("lockBoro").checked = S.lock; }
      if (top.mode && top.mode !== S.mode) { S.mode = top.mode; rebuildModel(); renderGroups(); }
      syncPresetSelect(); recompute(); return;
    }
    abortOptimizer();
    _undo(redo);
  };

  // ---------- auto-balance ----------
  const W = { pop: "wPop", compact: "wCompact", econ: "wEcon", race: "wRace", change: "wChange" };
  const O = { pop: "oPop", compact: "oCompact", econ: "oEcon", race: "oRace", change: "oChange" };
  function syncWeights() { for (const k in W) $(O[k]).textContent = (+$(W[k]).value).toFixed(1); }
  for (const k in W) $(W[k]).addEventListener("input", syncWeights);
  let running = null;
  // stop a running auto-balance without applying its result (the plan or model it was working on is being replaced)
  function abortOptimizer() {
    if (!running) return;
    running.stop = true; running.abort = true;
    $("optMsg").textContent = "Auto-balance stopped because the map changed.";
  }
  $("runOpt").onclick = () => {
    if (running) return;
    const s = S.stats.summary;
    if (s.unassigned) { toast("Assign every building first, or use “Draw starting map”."); return; }
    pushUndoAll(); markEdited();
    const weights = {}; for (const k in W) weights[k] = +$(W[k]).value;
    const opt = new E.Optimizer(S.model, S.plan, S.K, { weights, maxDev: +$("maxDev").value, lock: S.lock, pin: S.pin, seed: (Math.random() * 1e9) | 0 });
    const total = +$("effort").value, chunks = 120, per = Math.ceil(total / chunks);
    const t0 = 0.6, t1 = 0.003; let c = 0;
    const startScore = opt.score, before = Object.assign({}, S.stats.summary); let best = opt.score, bestPlan = Int16Array.from(S.plan), bestPin = Uint8Array.from(S.pin);
    running = { stop: false };
    $("runOpt").disabled = true; $("stopOpt").disabled = false; $("optMsg").textContent = "Working…";
    const tick = () => {
      if (running.abort) { $("runOpt").disabled = false; $("stopOpt").disabled = true; $("optBar").style.width = "0"; running = null; return; }
      const tEnd = performance.now() + 30;
      while (c < chunks && performance.now() < tEnd && !running.stop) {
        opt.step(per, t0 * Math.pow(t1 / t0, c / (chunks - 1))); c++;
        if (opt.score < best) { best = opt.score; bestPlan = Int16Array.from(S.plan); bestPin = Uint8Array.from(S.pin); }
      }
      $("optBar").style.width = (100 * c) / chunks + "%";
      recompute();
      if (c < chunks && !running.stop) { requestAnimationFrame(tick); return; }
      if (running.abort) { $("runOpt").disabled = false; $("stopOpt").disabled = true; $("optBar").style.width = "0"; running = null; return; }
      opt.step(per * 3, 0);
      if (opt.score > best) { S.plan.set(bestPlan); S.pin.set(bestPin); } else best = opt.score;
      recompute();
      $("optMsg").textContent = best < startScore - 0.05
        ? `Done. largest gap from the citywide average ±${pct0(before.maxDevCity)} → ±${pct0(S.stats.summary.maxDevCity)}, racial segregation ${before.theilH.toFixed(3)} → ${S.stats.summary.theilH.toFixed(3)}, economic ${before.theilEcon.toFixed(3)} → ${S.stats.summary.theilEcon.toFixed(3)}. Undo restores the previous map.`
        : `Done. No better map found with these settings. Try different weights or a higher effort.`;
      $("runOpt").disabled = false; $("stopOpt").disabled = true; running = null;
    };
    requestAnimationFrame(tick);
  };
  $("stopOpt").onclick = () => { if (running) running.stop = true; };
  $("lockBoro").onchange = (e) => { S.lock = e.target.checked; recompute(); };
  $("newSeed").onclick = () => {
    const K = Math.max(2, Math.min(60, +$("newK").value || 32));
    if (S.lock && K < 5) { toast("With districts kept inside boroughs, a starting map needs at least 5 districts (one per borough)."); return; }
    pushUndoAll(); S.K = K; S.plan = E.seedPlan(S.model, K, (Math.random() * 1e9) | 0, S.lock); S.pin = new Uint8Array(N);
    const o = new E.Optimizer(S.model, S.plan, K, { weights: { pop: 1, compact: 1 }, maxDev: 0.05, lock: S.lock, seed: 5 }); o.anneal(150000, 1.5, 0.01);
    if (K <= 32) E.relabelToCurrent(S.model, S.plan, K);
    S.active = 0; S.presetId = "custom"; syncPresetSelect(); recompute(); toast(`Drew a starting map with ${K} districts.`);
  };
  $("newBlank").onclick = () => {
    const K = Math.max(2, Math.min(60, +$("newK").value || 32));
    pushUndoAll(); S.K = K; S.plan = new Int16Array(N).fill(-1); S.pin = new Uint8Array(N); S.active = 0; S.presetId = "custom"; syncPresetSelect(); recompute();
  };

  // ---------- save & share ----------
  const OUT_UNITS = DATA.units.map((u, i) => (u.s.some((si) => DATA.schools[si][F.admin] && DATA.schools[si][F.admin] !== u.cur) ? i : -1)).filter((i) => i >= 0);
  function code() {
    const pins = OUT_UNITS.filter((i) => S.pin[i]).map((i) => i.toString(36)).join(",");
    return `v4.${LAYER}.${S.mode}.${S.K}.${S.lock ? 1 : 0}.${pins}.${E.encodePlan(S.plan)}`;
  }
  function renderCode() { const b = $("codeBox"); if (document.activeElement !== b) b.value = code(); }
  function loadCode(str, quiet) {
    const full = String(str).trim();
    const lm = full.match(/^v4\.([a-z]+)\./);
    if (lm && lm[1] !== LAYER && window.DATA_ALL && window.DATA_ALL[lm[1]]) { switchLayer(lm[1], full); return true; }
    const m = full.replace(/^v4\.[a-z]+\./, "v3.").match(/^v3\.([CHSR]+)\.(\d+)\.([01])\.([0-9a-z,]*)\.(.+)$/);
    const K = m ? +m[2] : 0;
    const plan = m && m[5].length === N ? E.decodePlan(m[5], N) : null;
    if (!plan || K < 2 || K > 64 || plan.some((d) => d >= K) || [...m[5]].some((ch) => ch !== "." && "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_".indexOf(ch) < 0)) {
      if (!quiet) toast("That code doesn't look like a plan from this tool, or it was made with an older version of the map.");
      return false;
    }
    pushUndoAll();
    S.mode = m[1]; rebuildModel(); renderGroups();
    S.K = +m[2]; S.lock = m[3] === "1"; $("lockBoro").checked = S.lock;
    S.plan = plan; S.pin = new Uint8Array(N);
    for (const t of m[4].split(",")) if (t) S.pin[parseInt(t, 36)] = 1;
    S.presetId = "custom"; syncPresetSelect(); recompute(); return true;
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`Copied ${what}.`); }
    catch (_) { const b = $("codeBox"); b.value = text; b.focus(); b.select(); toast("Press Ctrl+C (⌘C) to copy the selected text."); }
  }
  $("copyCode").onclick = () => copy(code(), "plan code");
  $("loadCode").onclick = () => { if (loadCode($("codeBox").value)) toast("Plan loaded."); };
  function csv() {
    const rows = [["dbn", "school", "type", "superintendent", "zone", "today_district", "plan_district", "enrollment", "counted"]];
    DATA.units.forEach((u, i) => {
      const inc = new Set(S.model.schoolsIn[i]);
      for (const si of u.s) { const s = DATA.schools[si]; const q = (v) => `"${String(v).replace(/"/g, '""')}"`; rows.push([s[F.dbn], q(s[F.name]), q(DATA.meta.groups[s[F.grp]]), q(s[F.sup]), q(u.id), s[F.admin] || u.cur, schoolDistrict(si) >= 0 ? schoolDistrict(si) + 1 : "", s[F.n], inc.has(si) ? "yes" : "no"]); }
    });
    return rows.map((r) => r.join(",")).join("\n");
  }
  $("copyCsv").onclick = () => copy(csv(), "CSV");
  $("dlCsv").onclick = () => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv()], { type: "text/csv" }));
    a.download = "nyc-district-plan.csv"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  function save() { try { localStorage.setItem(STORE, JSON.stringify({ code: code(), id: S.presetId })); } catch (_) {} }
  function restore() {
    try {
      if (window.PENDING_CODE && loadCode(window.PENDING_CODE)) return true;
      if (window.PENDING_CODE) return false;
      const h = location.hash.match(/^#plan=(.+)$/);
      if (h && loadCode(decodeURIComponent(h[1]))) return true;
      const v = JSON.parse(localStorage.getItem(STORE) || "null");
      if (v && v.id && v.id !== "custom" && PRESETS.some((p) => p.id === v.id)) { loadPreset(v.id); return true; }
      if (v && v.code) return loadCode(v.code, true);
    } catch (_) {}
    return false;
  }
  function switchLayer(key, pendingCode) {
    try { window.name = JSON.stringify({ nycsdbLayer: key, code: pendingCode || null }); } catch (_) {}
    try { localStorage.setItem("nycsdb.layer", key); } catch (_) {}
    document.body.style.cursor = "progress";
    location.reload();
  }
  const layerSel = $("layerSel");
  for (const k of window.LAYER_ORDER || [LAYER]) {
    const L = window.DATA_ALL ? window.DATA_ALL[k].meta : DATA.meta;
    const o = document.createElement("option"); o.value = k; o.textContent = `${L.layerName} (${fmtN(window.DATA_ALL ? window.DATA_ALL[k].units.length : N)} pieces)`; layerSel.appendChild(o);
  }
  layerSel.value = LAYER;
  $("layerDesc").textContent = DATA.meta.layerDesc + ". Switching starts over from today's map.";
  layerSel.onchange = () => switchLayer(layerSel.value);
  let toastT = 0;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600); }

  // ---------- resizable side panel ----------
  const mainEl = document.querySelector(".main");
  const PANEL_MIN = 340, NORMAL_W = 400;
  const panelMax = () => Math.max(PANEL_MIN, window.innerWidth - 220);
  const wideW = () => Math.min(panelMax(), 1240);
  function applyPanel(w) {
    S.panelW = Math.max(PANEL_MIN, Math.min(panelMax(), w || NORMAL_W));
    mainEl.style.setProperty("--panel-w", S.panelW + "px");
    const wide = S.panelW > NORMAL_W + 40;
    $("expandBtn").setAttribute("aria-pressed", wide);
    $("expandBtn").querySelector("span").textContent = wide ? "Collapse" : "Expand";
    $("expandBtn").title = wide ? "Shrink the panel back" : "Widen the panel over the map";
    requestAnimationFrame(() => setView(view));
    try { localStorage.setItem(STORE + ".panel", String(S.panelW)); } catch (_) {}
  }
  function togglePanel() { applyPanel(S.panelW > NORMAL_W + 40 ? NORMAL_W : wideW()); }
  $("expandBtn").onclick = togglePanel;
  $("resizer").addEventListener("dblclick", togglePanel);
  $("resizer").addEventListener("pointerdown", (e) => {
    e.preventDefault(); const r = $("resizer"); r.setPointerCapture(e.pointerId); r.classList.add("drag");
    const right = mainEl.getBoundingClientRect().right;
    const move = (ev) => applyPanel(right - ev.clientX);
    const up = () => { r.classList.remove("drag"); r.removeEventListener("pointermove", move); r.removeEventListener("pointerup", up); r.removeEventListener("pointercancel", up); };
    r.addEventListener("pointermove", move); r.addEventListener("pointerup", up); r.addEventListener("pointercancel", up);
  });
  try { applyPanel(+localStorage.getItem(STORE + ".panel") || NORMAL_W); } catch (_) { applyPanel(NORMAL_W); }

  // ---------- boot ----------
  $("yearTxt").textContent = DATA.meta.year; $("rosterTxt").textContent = DATA.meta.pulled || "October 2026";
  const nSchools = DATA.schools.length;
  $("dataNote").textContent = `${fmtN(nSchools)} schools in ${fmtN(N)} zones.` + (DATA.meta.dropped.length ? ` ${DATA.meta.dropped.length} could not be located and are left out.` : " Every school in the roster was located.");
  rebuildModel(); renderGroups(); syncWeights();
  if (!restore()) loadPreset("current");
  S.undo = []; S.redo = [];
  fit(); window.addEventListener("resize", () => { applyPanel(S.panelW); fit(); });
  if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => recompute());
  new MutationObserver(() => recompute()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
