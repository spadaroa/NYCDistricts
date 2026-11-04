"""Builds docs/district-colorer/index.html: a standalone map of the 32 NYC community school districts
where you select whole districts and set their colors. Self-contained (no server, no network needed except
optional Google Fonts). GitHub Pages serves it at /district-colorer/, separate from the district builder at /.

Usage: python3 prep/make_colorer.py raw
"""
import json, math, sys, os
import shapely
from shapely.geometry import shape
from shapely.ops import unary_union, polylabel

RAW = sys.argv[1] if len(sys.argv) > 1 else "raw"
LON0, LAT0 = -74.0, 40.7
KX = math.cos(math.radians(LAT0)) * 111320.0
KY = 110540.0
BORO = {}
for d in range(1, 7): BORO[d] = "M"
for d in range(7, 13): BORO[d] = "X"
for d in list(range(13, 24)) + [32]: BORO[d] = "K"
for d in range(24, 31): BORO[d] = "Q"
BORO[31] = "R"

dp = {}
for f in json.load(open(f"{RAW}/districts.geojson"))["features"]:
    d = int(float(f["properties"]["schooldist"]))
    g = shapely.transform(shape(f["geometry"]), lambda a: [((x - LON0) * KX, -(y - LAT0) * KY) for x, y in a]).buffer(0)
    dp[d] = unary_union([dp[d], g]).buffer(0) if d in dp else g

def path(g, tol):
    g = g.simplify(tol, preserve_topology=True)
    polys = [g] if g.geom_type == "Polygon" else list(g.geoms)
    out = []
    for p in polys:
        if p.area < 2000:
            continue
        for ring in [p.exterior] + list(p.interiors):
            c = list(ring.coords)[:-1]
            if len(c) < 3:
                continue
            out.append("M" + "L".join(f"{round(x)} {round(y)}" for x, y in c) + "Z")
    return "".join(out)

districts = []
for d in sorted(dp):
    g = dp[d]
    main = max(g.geoms, key=lambda p: p.area) if g.geom_type == "MultiPolygon" else g
    lp = polylabel(main, tolerance=20)
    districts.append(dict(d=d, b=BORO[d], path=path(g, 6), lx=round(lp.x), ly=round(lp.y)))
boros = {b: path(unary_union([dp[d] for d in dp if BORO[d] == b]).buffer(3).buffer(-3), 10) for b in "MXKQR"}
allg = unary_union(list(dp.values()))
minx, miny, maxx, maxy = allg.bounds
data = dict(districts=districts, boros=boros, bbox=[round(minx), round(miny), round(maxx - minx), round(maxy - miny)])

here = os.path.dirname(os.path.abspath(__file__))
tpl = open(os.path.join(here, "colorer_template.html")).read()
out = os.path.join(here, "..", "docs", "district-colorer", "index.html")
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, "w").write(tpl.replace("/*__DATA__*/null", json.dumps(data, separators=(",", ":"))))
print("wrote", out, os.path.getsize(out) // 1024, "KB")
