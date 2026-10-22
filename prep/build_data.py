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
from shapely.geometry import shape, Point, MultiPoint
from shapely.ops import unary_union, nearest_points
from shapely.strtree import STRtree

RAW = sys.argv[1] if len(sys.argv) > 1 else "raw"
OUT = sys.argv[2] if len(sys.argv) > 2 else "src/data.json"
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
for s in dropped: print("  no location:", s["dbn"], s["name"], s["n"])

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
# ---------- units = DOE elementary school zones, split at district lines ----------
ZONES = f"{RAW}/zones/cmjf-yawu.geojson"   # School Zones 2024-2025 (Elementary School), NYC Open Data
zf = json.load(open(ZONES))["features"]
pieces = []  # dict(geom, gd, zone)
for f in zf:
    pr = f["properties"]
    g = shapely.transform(shape(f["geometry"]), lambda a: [proj(x, y) for x, y in a]).buffer(0)
    label = (pr.get("dbn") or "").strip()
    zone = dict(dbn=label, remarks=(pr.get("remarks") or "").strip(), zd=pr.get("zoned_dist"))
    for d in dtree_keys:
        if not g.intersects(dpolys[d]): continue
        part = g.intersection(dpolys[d]).buffer(0)
        if part.area < 5000: continue        # slivers where DOE zone and DCP district lines differ slightly
        pieces.append(dict(geom=part, gd=d, zone=zone))
print("zone pieces:", len(pieces), "from", len(zf), "zones")
# land not covered by any zone (parks, marsh, slivers): merge into the neighboring piece in the same district
merged_gaps = 0
for d in dtree_keys:
    mine = [p for p in pieces if p["gd"] == d]
    covered = unary_union([p["geom"] for p in mine]) if mine else None
    gap = dpolys[d].difference(covered) if covered is not None else dpolys[d]
    for gp in (gap.geoms if hasattr(gap, "geoms") else [gap]):
        if gp.geom_type != "Polygon" or gp.area < 2000: continue
        best = max(mine, key=lambda p: p["geom"].buffer(10).intersection(gp).area, default=None)
        if best is not None and best["geom"].buffer(10).intersects(gp):
            best["geom"] = unary_union([best["geom"], gp]).buffer(0); merged_gaps += 1
        elif gp.area > 50000:
            pieces.append(dict(geom=gp, gd=d, zone=dict(dbn="", remarks="Not in any elementary zone", zd=None)))
print("gaps merged into neighboring zones:", merged_gaps)

units = [dict(b="", x=p["geom"].representative_point().x, y=p["geom"].representative_point().y,
              schools=[], gd=p["gd"], boro=BORO_OF_DIST[p["gd"]], zone=p["zone"]) for p in pieces]
cells = [p["geom"] for p in pieces]
ztree = STRtree(cells)
geo_mismatch, unplaced = [], 0
for b, ss in by_b.items():
    pt = Point(ss[0]["x"], ss[0]["y"])
    hits = [int(i) for i in ztree.query(pt, predicate="intersects")]
    if not hits:
        unplaced += 1
        hits = [int(ztree.nearest(pt))]
    u = hits[0]
    for s in ss: units[u]["schools"].append(s)
    lg = Counter(s["geo"] for s in ss).most_common(1)[0][0]
    if lg and lg != units[u]["gd"]: geo_mismatch.append((b, ss[0]["addr"], lg, units[u]["gd"]))
# give each unit a readable name: its zoned school(s)
dbn_name = {s["dbn"]: s["name"] for s in schools}
for i, u in enumerate(units):
    z = u["zone"]; ids = [x for x in z["dbn"].split(",") if x]
    u["b"] = ("Zone of " + " / ".join(dbn_name.get(x, x) for x in ids)) if ids else (z["remarks"] or "Unzoned area")
    u["zdbn"] = z["dbn"]; u["zrem"] = z["remarks"]
print("units:", len(units), "buildings placed by nearest zone:", unplaced, "LCGMS geo-district != zone district:", len(geo_mismatch))
for m in geo_mismatch[:30]: print("  ", m)

# adjacency + shared edges
tree = STRtree(cells)
edges, nbr = [], defaultdict(dict)
for i, g in enumerate(cells):
    for j in tree.query(g.buffer(1)):
        j = int(j)
        if j <= i: continue
        inter = g.boundary.intersection(cells[j].boundary)
        if inter.length < 5:  # neighboring districts' lines don't always coincide exactly: allow a small gap
            inter = g.buffer(8).intersection(cells[j].boundary)
        if inter.is_empty or inter.length < 5: continue
        if inter.geom_type not in ("LineString", "MultiLineString"):
            inter = shapely.MultiLineString([q for q in getattr(inter, "geoms", []) if q.geom_type == "LineString"])
            if inter.is_empty or inter.length < 5: continue
        nbr[i][j] = inter.length; nbr[j][i] = inter.length
        edges.append((i, j, inter))
# connect pieces split by water inside a borough (nearest pair)
virtual = []
def comps(ids):
    ids = set(ids); seen = set(); out = []
    for s in ids:
        if s in seen: continue
        st = [s]; seen.add(s); c = []
        while st:
            a = st.pop(); c.append(a)
            for b2 in nbr[a]:
                if b2 in ids and b2 not in seen: seen.add(b2); st.append(b2)
        out.append(c)
    return out
groups_to_link = [[i for i, u in enumerate(units) if u["gd"] == d] for d in dtree_keys] + \
                 [[i for i, u in enumerate(units) if u["boro"] == b] for b in sorted(set(BORO_OF_DIST.values()))]
for ids in groups_to_link:   # first join each district's own pieces (islands, peninsulas), then each borough
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
print("edges:", len(edges), "water links:", len(virtual))

# ---------- serialize ----------
def rings(geom, tol):
    g = geom.simplify(tol, preserve_topology=True)
    polys = [g] if g.geom_type == "Polygon" else [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
    return [[v for xy in p.exterior.coords[:-1] for v in (round(xy[0]), round(-xy[1]))] for p in polys if p.area >= 1500]
def lines(geom, tol):
    g = shapely.line_merge(geom) if geom.geom_type == "MultiLineString" else geom
    parts = [g] if g.geom_type == "LineString" else [p for p in getattr(g, "geoms", []) if p.geom_type == "LineString"]
    return [[v for xy in p.simplify(tol).coords for v in (round(xy[0]), round(-xy[1]))] for p in parts]

FIELDS = ["dbn", "name", "grp", "admin", "n", "k8", "hs", "asian", "black", "hisp", "white", "multi", "native",
          "pov", "ell", "swd", "eni", "unit", "x", "y", "sup", "net", "grades"]
out_s, out_u = [], []
for i, u in enumerate(units):
    sid = []
    bk = defaultdict(list)
    for s in u["schools"]: bk[s["bldg"] or s["dbn"]].append(s)
    for bl, ss in bk.items():
        for k, s in enumerate(ss):
            sid.append(len(out_s))
            # spread co-located schools in a small ring so each dot is visible
            ang = 2 * math.pi * k / max(1, len(ss)); rr = 0 if len(ss) == 1 else 30
            s2 = dict(s, unit=i, x=round(s["x"] + rr * math.cos(ang)), y=round(-(s["y"] + rr * math.sin(ang))))
            out_s.append([s2[f] for f in FIELDS])
    c = cells[i]
    cur = u["gd"]   # territory always starts in the district whose lines it is in
    out_u.append(dict(id=u["b"], z=u["zdbn"], x=round(u["x"]), y=round(-u["y"]), b=u["boro"], gd=u["gd"], cur=cur, s=sid,
                      a=round(c.area), p=round(c.length), poly=rings(c, 10),
                      nb=[[j, round(L)] for j, L in sorted(nbr[i].items())]))
data = dict(
    meta=dict(year=YEAR, pulled=__import__("datetime").date.fromtimestamp(os.path.getmtime(f"{RAW}/lcgms/lcgms.csv")).strftime("%B %-d, %Y"), fields=FIELDS,
              groups={"C": "Community superintendent", "H": "High school superintendent", "S": "District 75", "A": "District 79", "R": "Charter"},
              dropped=[[s["dbn"], s["name"], s["n"]] for s in dropped], water_links=virtual,
              geo_mismatch=geo_mismatch, units="DOE elementary school zones 2024-25, split at district lines"),
    schools=out_s, units=out_u,
    edges=[[i, j, lines(g, 8)] for i, j, g in edges],
    districts={str(d): rings(g, 15) for d, g in dpolys.items()},
)
json.dump(data, open(OUT, "w"), separators=(",", ":"))
print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB")
