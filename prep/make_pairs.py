"""Paired-zones example (elementary zones layer).

Finds adjacent DOE elementary school zones whose zoned schools differ by 25+ percentage points in BOTH
the Black + Hispanic share and the share of economically disadvantaged (poverty) students, then picks a
set of non-overlapping pairs (each school paired at most once) with the largest combined gaps.

Zone demographics use the zoned school's 2025-26 enrollment (Demographic Snapshot), counting only zoned
schools that serve elementary grades. Adjacent = the two zones share at least 100 m of border.

Writes:
  src/presets_es.json        adds/replaces the "pairs" example (today's district lines + the pairs)
  src/pairs_es.json          every qualifying pair, with the modeled ones flagged (for the report)
Usage: python3 prep/make_pairs.py [threshold_points]
"""
import json, sys, collections
import networkx as nx

TH = float(sys.argv[1]) if len(sys.argv) > 1 else 25.0
d = json.load(open("src/data_es.json"))
F = {f: i for i, f in enumerate(d["meta"]["fields"])}
U = d["units"]
sch = {s[F["dbn"]]: s for s in d["schools"]}
ES = ("0K", "01", "02", "03", "04", "05")

zones = collections.defaultdict(list)          # zone code -> unit indexes
for i, u in enumerate(U):
    if u["z"]:
        zones[u["z"]].append(i)

def zone_demo(z):
    ss = [sch[x] for x in z.split(",") if x in sch]
    ss = [s for s in ss if any(g in s[F["grades"]] for g in ES) and s[F["n"]] > 0]
    if not ss:
        return None
    n = sum(s[F["n"]] for s in ss)
    return dict(n=n, bh=sum(s[F["black"]] + s[F["hisp"]] for s in ss) / n, pov=sum(s[F["pov"]] for s in ss) / n,
                dbns=[s[F["dbn"]] for s in ss], names=[s[F["name"]] for s in ss], district=U[zones[z][0]]["gd"],
                boro=U[zones[z][0]]["b"])

Z = {z: v for z in zones if (v := zone_demo(z))}
border = collections.defaultdict(float)
for i, u in enumerate(U):
    for j, L in u["nb"]:
        a, b = u["z"], U[j]["z"]
        if a in Z and b in Z and a != b and L > 0:
            border[tuple(sorted((a, b)))] += L / 2

pairs = []
for (a, b), L in border.items():
    dbh = abs(Z[a]["bh"] - Z[b]["bh"]) * 100
    dpv = abs(Z[a]["pov"] - Z[b]["pov"]) * 100
    if dbh >= TH and dpv >= TH:
        pairs.append(dict(a=a, b=b, dbh=round(dbh, 1), dpov=round(dpv, 1), border_m=round(L)))

# a school can only be paired once: choose the non-overlapping set with the largest combined gaps
G = nx.Graph()
for p in pairs:
    G.add_edge(p["a"], p["b"], weight=p["dbh"] + p["dpov"])
chosen = {tuple(sorted(e)) for e in nx.max_weight_matching(G, maxcardinality=True)}
for p in pairs:
    p["modeled"] = (p["a"], p["b"]) in chosen or (p["b"], p["a"]) in chosen

modeled = [p for p in pairs if p["modeled"]]
print(f"threshold {TH} pts: {len(Z)} zones with an elementary zoned school, {len(border)} adjacent zone pairs, "
      f"{len(pairs)} pairs meet both tests ({len({x for p in pairs for x in (p['a'], p['b'])})} zones); "
      f"{len(modeled)} non-overlapping pairs modeled; "
      f"{sum(1 for p in pairs if Z[p['a']]['district'] != Z[p['b']]['district'])} pairs cross a district line")

json.dump(dict(threshold=TH, zones={z: Z[z] for z in {x for p in pairs for x in (p["a"], p["b"])}}, pairs=pairs),
          open("src/pairs_es.json", "w"))

presets = json.load(open("src/presets_es.json"))
cur = next(p for p in presets if p["id"] == "current")
ex = dict(cur, id="pairs", name="Paired zones (25-pt gaps)",
          desc=(f"Today's district lines, with {len(modeled)} pairs of neighboring elementary zones combined. "
                f"Each pair's zoned schools differ by {TH:.0f}+ points in both the Black and Hispanic share and the share of "
                f"students in poverty ({len(pairs)} such neighboring pairs exist; a school is paired only once). "
                "A paired zone sends all its students to both schools, so each school takes on the pair's combined mix. "
                "Compare Race H and Econ H on the Districts tab, and the within-district rows in Topline."),
          weights=None, pairs=[[Z[p["a"]]["dbns"], Z[p["b"]]["dbns"]] for p in modeled],
          pairZones=[[p["a"], p["b"]] for p in modeled])
presets = [p for p in presets if p["id"] != "pairs"]
presets.insert(1, ex)
json.dump(presets, open("src/presets_es.json", "w"))
