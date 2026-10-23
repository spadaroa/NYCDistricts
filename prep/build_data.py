"""Build map units + school data for the NYC School District Builder.

Inputs in RAW/:
  lcgms/lcgms.csv     NYC DOE LCGMS school roster (current; superintendents, buildings, addresses)
  geocode_cache.json  building addresses geocoded with NYC GeoSearch (prep/geocode.py)
  demo.xlsx           NYC DOE Demographic Snapshot 2021-22 to 2025-26 (InfoHub)
  districts.geojson   DCP School Districts (NYC Open Data 8ugf-3d8u)
  facdb*.json, loc1920.json   fallback locations
Output: src/data.json
"""
import json, math, sys, os
from collections import defaultdict, Counter
import pandas as pd
import shapely
from shapely.geometry import shape, Point, MultiPoint, Polygon
from shapely.ops import unary_union, nearest_points
from shapely.strtree import STRtree

RAW = sys.argv[1] if len(sys.argv) > 1 else "raw"
OUTDIR = sys.argv[2] if len(sys.argv) > 2 else "src"
YEAR = "2025-26"
LON0, LAT0 = -74.0, 40.7
KX = math.cos(math.radians(LAT0)) * 111320.0
KY = 110540.0
proj = lambda lon, lat: ((lon - LON0) * KX, (lat - LAT0) * KY)

BORO_OF_DIST = {}
for d in range(1, 7): BORO_OF_DIST[d] = "M"
for d in range(7, 13): BORO_OF_DIST[d] = "X"
for d in list(range(13, 24)) + [32]: BORO_OF_DIST[d] = "K"
for d in range(24, 31): BORO_OF_DIST[d] = "Q"
BORO_OF_DIST[31] = "R"

FROM_JSON = os.environ.get("FROM_JSON")
if not FROM_JSON:
    # ---------- roster (LCGMS) ----------
    L = pd.read_csv(f"{RAW}/lcgms/lcgms.csv", header=1, dtype=str); L.columns = [c.strip() for c in L.columns]
    L = L[(L["Status Description"].str.strip() == "Open") & L["ATS System Code"].notna()]
    def clean(v):
        v = "" if pd.isna(v) else str(v).strip()
        return "" if v.upper() == "NULL" else v
    def group_of(r):
        if clean(r["Managed By Name"]) == "Charter": return "R"          # charter
        ad = clean(r["Administrative District Code"])
        if ad == "75": return "S"                                       # D75 citywide special ed
        if ad == "79" or "ALTERNATIVE" in clean(r["Administrative District Name"]).upper(): return "A"  # D79
        if clean(r["HighSchool Network Name"]): return "H"              # high school superintendent
        return "C"                                                      # community superintendent

    # ---------- demographics ----------
    demo = pd.read_excel(f"{RAW}/demo.xlsx", sheet_name="School")
    demo = demo[demo.Year == YEAR].set_index("DBN")
    def num(v, total=None):
        if isinstance(v, (int, float)) and not pd.isna(v): return float(v)
        s = str(v).strip()
        if s.startswith("Above 95"): return 0.97 * total if total is not None else 0.97
        if s.startswith("Below 5"): return 0.03 * total if total is not None else 0.03
        try: return float(s.replace("%", "")) / (100 if "%" in s else 1)
        except ValueError: return 0.0
    GR = ["Grade 3K", "Grade PK (Half Day & Full Day)", "Grade K"] + [f"Grade {i}" for i in range(1, 13)]

    # ---------- locations ----------
    geo = json.load(open(f"{RAW}/geocode_cache.json"))
    fac = pd.DataFrame(json.load(open(f"{RAW}/facdb.json")) + json.load(open(f"{RAW}/facdb_charter.json")))
    fac["bblf"] = pd.to_numeric(fac.bbl, errors="coerce")
    fac_bbl = {int(r.bblf): (float(r.longitude), float(r.latitude)) for r in fac.dropna(subset=["bblf"]).itertuples()}
    loc = pd.DataFrame(json.load(open(f"{RAW}/loc1920.json")))
    loc = loc[pd.to_numeric(loc.latitude, errors="coerce").notna()]
    loc_b = {r.primary_building_code: (float(r.longitude), float(r.latitude)) for r in loc.itertuples()}

    def candidates(r):
        """Possible coordinates for a school, best source first."""
        out = []
        text = f"{r['Primary Address']}, {r['City']}, NY {str(r['Zip'])[:5]}"
        g = geo.get(text)
        if g: out.append(((g["lon"], g["lat"]), "geosearch"))
        try:
            b = int(float(r["Borough Block Lot"]))
            if b in fac_bbl: out.append((fac_bbl[b], "facdb"))
        except (TypeError, ValueError): pass
        if r["Building Code"] in loc_b: out.append((loc_b[r["Building Code"]], "doe1920"))
        return out

    schools, dropped = [], []
    for _, r in L.iterrows():
        dbn = clean(r["ATS System Code"])
        grp = group_of(r)
        ad = clean(r["Administrative District Code"])
        admin = int(ad) if ad.isdigit() and 1 <= int(ad) <= 32 and grp in "CH" else 0
        gd = clean(r["Geographical District Code"])
        sup = clean(r["Community School Sup Name"]) if grp == "C" else clean(r["HighSchool Network Superintendent"]) if grp == "H" else ""
        net = clean(r["HighSchool Network Name"]) if grp == "H" else ""
        s = dict(dbn=dbn, name=clean(r["Location Name"]).replace("�", "–"), grp=grp, admin=admin,
                 geo=int(gd) if gd.isdigit() else 0, sup=sup.title() if sup.isupper() else sup, net=net,
                 bldg=clean(r["Building Code"]), addr=clean(r["Primary Address"]), grades=clean(r["Grades Final"]))
        if dbn in demo.index:
            x = demo.loc[dbn]; tot = float(x["Total Enrollment"])
            g = [float(x[c]) for c in GR]
            s.update(n=round(tot), k8=round(sum(g[:12])), hs=round(sum(g[12:])),
                     asian=round(num(x["# Asian and Pacific Islander"], tot)), black=round(num(x["# Black"], tot)),
                     hisp=round(num(x["# Hispanic"], tot)), white=round(num(x["# White"], tot)),
                     multi=round(num(x["# Multi-Racial"], tot)), native=round(num(x["# Native American"], tot)),
                     pov=round(num(x["# Poverty"], tot)), ell=round(num(x["# English Language Learners"], tot)),
                     swd=round(num(x["# Students with Disabilities"], tot)), eni=round(num(x["Economic Need Index"]), 3))
        else:
            s.update(n=0, k8=0, hs=0, asian=0, black=0, hisp=0, white=0, multi=0, native=0, pov=0, ell=0, swd=0, eni=0)
        s["cands"] = candidates(r)
        if not s["cands"]: dropped.append(s); continue
        schools.append(s)
    print("schools located:", len(schools), Counter(s["grp"] for s in schools), "dropped:", len(dropped))
    PULLED = __import__("datetime").date.fromtimestamp(os.path.getmtime(f"{RAW}/lcgms/lcgms.csv")).strftime("%B %-d, %Y")
    for s in dropped: print("  no location:", s["dbn"], s["name"], s["n"])

else:
    # Rebuild from an existing area-layer file (src/data_area.json) instead of the raw roster, so one layer can be
    # rebuilt with exactly the same schools and locations as the others. Each area-layer unit is one building.
    _src = json.load(open(FROM_JSON)); _F = _src["meta"]["fields"]
    schools, dropped = [], [dict(dbn=a, name=b, n=c) for a, b, c in _src["meta"]["dropped"]]
    for u in _src["units"]:
        ss = [dict(zip(_F, _src["schools"][si])) for si in u["s"]]
        if not ss: continue
        cx, cy = sum(s["x"] for s in ss) / len(ss), -sum(s["y"] for s in ss) / len(ss)
        for s in ss: s.update(bldg=u["z"] or s["dbn"], x=cx, y=cy, geo=u["gd"]); schools.append(s)
    PULLED = _src["meta"]["pulled"]
    print("schools from", FROM_JSON, len(schools))

# ---------- district polygons (exact DCP lines) ----------
gj = json.load(open(f"{RAW}/districts.geojson"))
dpolys = {}
for f in gj["features"]:
    d = int(float(f["properties"]["schooldist"]))
    g = shapely.transform(shape(f["geometry"]), lambda a: [proj(x, y) for x, y in a]).buffer(0)
    dpolys[d] = unary_union([dpolys[d], g]).buffer(0) if d in dpolys else g
dtree_keys = sorted(dpolys)

# ---------- units = buildings ----------
def dist_at(x, y):
    p = Point(x, y)
    return next((d for d in dtree_keys if dpolys[d].contains(p)), None)
by_b = defaultdict(list)
for s in schools: by_b[s["bldg"] or s["dbn"]].append(s)
if not FROM_JSON:
    fixed = []
    for b, ss in by_b.items():
        # pick the first candidate (over all schools in the building) that falls in LCGMS's geographic district,
        # else one in the right borough, else the first one
        want = Counter(s["geo"] for s in ss if s["geo"]).most_common(1)
        want = want[0][0] if want else None
        cands = [c for s in ss for c in s["cands"]]
        pick = None
        for (lon, lat), src in cands:
            x, y = proj(lon, lat)
            if want and dist_at(x, y) == want: pick = (x, y, src); break
        if pick is None and want:
            for (lon, lat), src in cands:
                x, y = proj(lon, lat); d = dist_at(x, y)
                if d and BORO_OF_DIST.get(d) == BORO_OF_DIST.get(want): pick = (x, y, src); break
        if pick is None:
            (lon, lat), src = cands[0]; x, y = proj(lon, lat); pick = (x, y, src)
        if pick[2] != cands[0][1] or (lambda d: d != want)(dist_at(*proj(*cands[0][0]))): fixed.append((b, ss[0]["addr"], cands[0][1], pick[2]))
        for s in ss: s["x"], s["y"], s["locsrc"] = pick
    print("buildings where the first geocode was replaced:", len(fixed))
# ======================================================================================
# Building-block layers. Each one is a set of polygons split at the official district lines.
# ======================================================================================
def solid(g, w=6, min_area=3000):
    """Remove thin strips (narrower than ~2*w metres) and tiny parts, so blocks can't touch far-away
    blocks through slivers left where source lines and DCP district lines don't match."""
    g = g.buffer(0).buffer(-w).buffer(w)
    parts = [q for q in (g.geoms if hasattr(g, "geoms") else [g]) if q.geom_type == "Polygon" and q.area >= min_area]
    return unary_union(parts) if parts else Polygon()

def load(path):
    return [(f["properties"], shapely.transform(shape(f["geometry"]), lambda a: [proj(x, y) for x, y in a]).buffer(0))
            for f in json.load(open(path))["features"] if f["geometry"]]

dbn_name = {s["dbn"]: s["name"] for s in schools}
def zone_label(kind):
    def f(pr):
        ids = [x.strip() for x in (pr.get("dbn") or "").split(",") if x.strip()]
        rem = (pr.get("remarks") or "").strip()
        if ids: return f"{kind} zone of " + " / ".join(dbn_name.get(x, x) for x in ids), ",".join(ids)
        return (rem or f"{kind} zone"), ""
    return f

def split_pieces(polys, label_fn, gap_label):
    pieces = []
    for pr, g in polys:
        name, code = label_fn(pr)
        for d in dtree_keys:
            if not g.intersects(dpolys[d]): continue
            part = solid(g.intersection(dpolys[d]))
            if part.is_empty or part.area < 5000: continue
            pieces.append(dict(geom=part, gd=d, name=name, code=code))
    return fill_gaps(pieces, gap_label)

def fill_gaps(pieces, gap_label):
    # land not covered by any block (parks, marsh, slivers): merge into the neighboring block in the same district
    for d in dtree_keys:
        mine = [p for p in pieces if p["gd"] == d]
        covered = unary_union([p["geom"] for p in mine]) if mine else None
        gap = solid(dpolys[d].difference(covered), w=10, min_area=2000) if covered is not None else dpolys[d]
        for gp in (gap.geoms if hasattr(gap, "geoms") else [gap]):
            if gp.geom_type != "Polygon" or gp.area < 2000: continue
            best = max(mine, key=lambda p: p["geom"].buffer(10).intersection(gp).area, default=None)
            if best is not None and best["geom"].buffer(10).intersects(gp):
                best["geom"] = unary_union([best["geom"], gp.buffer(1)]).buffer(0)
            elif gp.area > 50000:
                pieces.append(dict(geom=gp, gd=d, name=gap_label, code=""))
    return pieces

def school_area_pieces():
    """Nearest-school-building areas inside each district, made of whole 2020 Census blocks so the edges follow
    streets. Each block (split at the DCP line) goes to the building nearest to it; any detached part of an area
    then joins the neighboring area it shares the most border with, so every area is one piece."""
    blocks = [g for _, g in load(f"{RAW}/blocks/wmsu-5muw.geojson")]
    btree = STRtree(blocks)
    bpts = defaultdict(list)
    for b, ss in by_b.items():
        p = Point(ss[0]["x"], ss[0]["y"]); d = dist_at(p.x, p.y) or min(dtree_keys, key=lambda k: dpolys[k].distance(p))
        bpts[d].append((b, p))
    pieces = []
    for d, items in sorted(bpts.items()):
        poly = dpolys[d]
        parts = [c for c in (blocks[int(i)].intersection(poly) for i in btree.query(poly, predicate="intersects")) if c.area >= 50]
        # the block a building stands on is that building's; buildings sharing a block share one area (the first
        # building is its seed), and every other block goes to the nearest seed
        ctree = STRtree(parts); taken = {}
        for o, (b, pt) in enumerate(items):
            hit = [int(i) for i in ctree.query(pt, predicate="intersects")] or [int(ctree.nearest(pt))]
            taken.setdefault(hit[0], o)
        seeds = sorted(set(taken.values()))
        ptree = STRtree([items[o][1] for o in seeds])
        groups = defaultdict(list)
        for k, c in enumerate(parts): groups[taken[k] if k in taken else seeds[int(ptree.nearest(c.representative_point()))]].append(c)
        geoms = {o: unary_union(gs).buffer(0) for o, gs in groups.items()}
        for _ in range(6):  # give detached parts to the neighbor sharing the most border
            moved = 0
            for o in list(geoms):
                g = geoms[o]
                if g.geom_type != "MultiPolygon": continue
                pt = items[o][1]
                ps = sorted(g.geoms, key=lambda q: (not q.intersects(pt.buffer(1)), q.distance(pt), -q.area))
                keep = [ps[0]]
                for q in ps[1:]:
                    qb = q.buffer(1)
                    best = max(((qb.intersection(geoms[o2].boundary).length, o2) for o2 in geoms if o2 != o and geoms[o2].intersects(qb)), default=(0, None))
                    if best[1] is None or best[0] < 1: keep.append(q); continue
                    geoms[best[1]] = unary_union([geoms[best[1]], q]).buffer(0); moved += 1
                geoms[o] = unary_union(keep).buffer(0)
            if not moved: break
        # buildings left without blocks of their own (e.g., two buildings on one block) share the area they sit in
        members = defaultdict(list)
        for o, (b, pt) in enumerate(items):
            if o in geoms and not geoms[o].is_empty: members[o].append(b); continue
            host = min(geoms, key=lambda k: geoms[k].distance(pt)); members[host].append(b)
        for o, g in geoms.items():
            if g.is_empty: continue
            c = solid(g, w=2, min_area=200)
            if c.is_empty: c = g
            bs = members[o] or [items[o][0]]
            names = sorted(set(s["name"] for b in bs for s in by_b[b]))
            pieces.append(dict(geom=c, gd=d, name="Area around " + names[0] + (f" (+{len(names) - 1} more)" if len(names) > 1 else ""), code=",".join(bs)))
    return fill_gaps(pieces, "Not near a school building")

FIELDS = ["dbn", "name", "grp", "admin", "n", "k8", "hs", "asian", "black", "hisp", "white", "multi", "native",
          "pov", "ell", "swd", "eni", "unit", "x", "y", "sup", "net", "grades"]
MIN_SHARED = 100  # metres; shorter contacts are corner touches or slivers where source and DCP lines differ

def rings(geom, tol):
    g = geom.simplify(tol, preserve_topology=True)
    polys = [g] if g.geom_type == "Polygon" else [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
    return [[v for xy in p.exterior.coords[:-1] for v in (round(xy[0]), round(-xy[1]))] for p in polys if p.area >= 1500]
def lines(geom, tol):
    g = shapely.line_merge(geom) if geom.geom_type == "MultiLineString" else geom
    parts = [g] if g.geom_type == "LineString" else [p for p in getattr(g, "geoms", []) if p.geom_type == "LineString"]
    return [[v for xy in p.simplify(tol).coords for v in (round(xy[0]), round(-xy[1]))] for p in parts]

def build_layer(key, label, desc, pieces):
    units = [dict(b=p["name"], z=p["code"], x=p["geom"].representative_point().x, y=p["geom"].representative_point().y,
                  schools=[], gd=p["gd"], boro=BORO_OF_DIST[p["gd"]]) for p in pieces]
    cells = [p["geom"] for p in pieces]
    ztree = STRtree(cells)
    for b, ss in by_b.items():
        pt = Point(ss[0]["x"], ss[0]["y"])
        hits = [int(i) for i in ztree.query(pt, predicate="intersects")]
        u = hits[0] if hits else int(ztree.nearest(pt))
        units[u]["schools"].extend(ss)
    tree = STRtree(cells)
    edges, nbr = [], defaultdict(dict)
    for i, g in enumerate(cells):
        for j in tree.query(g.buffer(1)):
            j = int(j)
            if j <= i: continue
            inter = g.boundary.intersection(cells[j].boundary)
            if inter.length < 5:
                inter = g.buffer(8).intersection(cells[j].boundary)
            if inter.is_empty or inter.length < 5: continue
            if inter.geom_type not in ("LineString", "MultiLineString"):
                inter = shapely.MultiLineString([q for q in getattr(inter, "geoms", []) if q.geom_type == "LineString"])
                if inter.is_empty or inter.length < 5: continue
            edges.append((i, j, inter))
            if inter.length >= MIN_SHARED:
                nbr[i][j] = inter.length; nbr[j][i] = inter.length
    virtual = []
    def comps(ids):
        ids = set(ids); seen = set(); out = []
        for s0 in ids:
            if s0 in seen: continue
            st = [s0]; seen.add(s0); c = []
            while st:
                a = st.pop(); c.append(a)
                for b2 in nbr[a]:
                    if b2 in ids and b2 not in seen: seen.add(b2); st.append(b2)
            out.append(c)
        return out
    groups = [[i for i, u in enumerate(units) if u["gd"] == d] for d in dtree_keys] + \
             [[i for i, u in enumerate(units) if u["boro"] == b] for b in sorted(set(BORO_OF_DIST.values()))]
    for ids in groups:   # join each district's own pieces (islands, peninsulas) first, then each borough
        while True:
            cs = sorted(comps(ids), key=len, reverse=True)
            if len(cs) <= 1: break
            main = cs[0]; best = None
            for c in cs[1:]:
                for a in c:
                    for m in main:
                        dd = cells[a].distance(cells[m])
                        if best is None or dd < best[0]: best = (dd, a, m)
            _, a, m = best
            nbr[a][m] = 0.0; nbr[m][a] = 0.0; virtual.append((a, m))
    out_s, out_u = [], []
    for i, u in enumerate(units):
        sid = []
        bk = defaultdict(list)
        for s in u["schools"]: bk[s["bldg"] or s["dbn"]].append(s)
        for bl, ss in bk.items():
            for k, s in enumerate(ss):
                sid.append(len(out_s))
                ang = 2 * math.pi * k / max(1, len(ss)); rr = 0 if len(ss) == 1 else 30
                s2 = dict(s, unit=i, x=round(s["x"] + rr * math.cos(ang)), y=round(-(s["y"] + rr * math.sin(ang))))
                out_s.append([s2[f] for f in FIELDS])
        c = cells[i]
        out_u.append(dict(id=u["b"], z=u["z"], x=round(u["x"]), y=round(-u["y"]), b=u["boro"], gd=u["gd"], cur=u["gd"], s=sid,
                          a=round(c.area), p=round(c.length), poly=rings(c, 10),
                          nb=[[j, round(L)] for j, L in sorted(nbr[i].items())]))
    data = dict(
        meta=dict(year=YEAR, pulled=PULLED,
                  fields=FIELDS, layer=key, layerName=label, layerDesc=desc,
                  groups={"C": "Community superintendent", "H": "High school superintendent", "S": "District 75", "A": "District 79", "R": "Charter"},
                  dropped=[[s["dbn"], s["name"], s["n"]] for s in dropped], water_links=virtual),
        schools=out_s, units=out_u,
        edges=[[i, j, lines(g, 8)] for i, j, g in edges],
        districts={str(d): rings(g, 15) for d, g in dpolys.items()},
    )
    path = f"{OUTDIR}/data_{key}.json"
    json.dump(data, open(path, "w"), separators=(",", ":"))
    print(f"[{key}] units {len(units)}, edges {len(edges)}, water links {len(virtual)} -> {path} {os.path.getsize(path) // 1024} KB")

LAYERS = sys.argv[3].split(",") if len(sys.argv) > 3 else ["es", "ms", "tract", "area"]
if "es" in LAYERS:
    build_layer("es", "Elementary school zones", "DOE elementary school attendance zones, 2024–25",
                split_pieces(load(f"{RAW}/zones/cmjf-yawu.geojson"), zone_label("Elementary"), "Not in any elementary zone"))
if "ms" in LAYERS:
    ms = load(f"{RAW}/zones/t26j-jbq7.geojson")
    choice = [g for pr, g in ms if "no zoned school" in (pr.get("remarks") or "").lower()]
    zoned = [(pr, g) for pr, g in ms if "no zoned school" not in (pr.get("remarks") or "").lower()]
    # districts with middle school choice have one district-wide "zone"; use elementary zones there instead
    choice_u = unary_union(choice)
    es_in_choice = [(dict(pr, remarks=(pr.get("remarks") or "")), g.intersection(choice_u)) for pr, g in load(f"{RAW}/zones/cmjf-yawu.geojson") if g.intersects(choice_u)]
    lab_ms, lab_es = zone_label("Middle school"), zone_label("Elementary")
    polys = [(dict(pr, _k="ms"), g) for pr, g in zoned] + [(dict(pr, _k="es"), g) for pr, g in es_in_choice if g.area > 5000]
    build_layer("ms", "Middle school zones", "DOE middle school attendance zones, 2024–25. In districts with middle school choice (no zones), elementary zones are used.",
                split_pieces(polys, lambda pr: (lab_ms if pr["_k"] == "ms" else lab_es)(pr), "Not in any middle school zone"))
if "tract" in LAYERS:
    tr = load(f"{RAW}/tracts/63ge-mke6.geojson")
    build_layer("tract", "Census tracts", "2020 Census tracts, the blocks most often used for redistricting",
                split_pieces(tr, lambda pr: (f"Census tract {pr.get('ctlabel')} · {pr.get('ntaname')}", pr.get("boroct2020") or ""), "Outside census tracts"))
if "area" in LAYERS:
    build_layer("area", "School areas", "The city blocks in each district nearest each school building",
                school_area_pieces())
