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

# Only pairs that cross a district line matter here: pairing them means redrawing the line so both zones sit in
# one district. A zone's district = the district holding most of its area (53 zones straddle a line slightly).
def zone_district(z):
    c = collections.Counter()
    for i in zones[z]:
        c[U[i]["gd"]] += U[i]["a"]
    return c.most_common(1)[0][0]
for p in pairs:
    p["crosses"] = zone_district(p["a"]) != zone_district(p["b"])
cross = [p for p in pairs if p["crosses"]]

# a school can only be paired once: choose the non-overlapping set with the largest combined gaps
G = nx.Graph()
for p in cross:
    G.add_edge(p["a"], p["b"], weight=p["dbh"] + p["dpov"])
chosen = {tuple(sorted(e)) for e in nx.max_weight_matching(G, maxcardinality=True)}
for p in pairs:
    p["modeled"] = tuple(sorted((p["a"], p["b"]))) in chosen

# redraw: for each modeled pair, move one whole zone into its partner's district. Try both directions; keep the
# one that leaves every district in one piece and moves fewer community-superintendent students.
cur = [u["cur"] - 1 for u in U]
plan = cur[:]
def students(units):
    return sum(sch_row[F["n"]] for i in units for sch_row in (d["schools"][k] for k in U[i]["s"]) if sch_row[F["grp"]] == "C")
def connected(dist, plan):
    ids = [i for i in range(len(U)) if plan[i] == dist]
    if not ids:
        return True
    seen = {ids[0]}; st = [ids[0]]
    while st:
        a = st.pop()
        for j, _ in U[a]["nb"]:
            if plan[j] == dist and j not in seen:
                seen.add(j); st.append(j)
    return len(seen) == len(ids)
moved = {}
school_unit = {row[F["dbn"]]: row[F["unit"]] for row in d["schools"]}
for p in [p for p in cross if p["modeled"]]:
    best = None
    for mover, keeper in ((p["a"], p["b"]), (p["b"], p["a"])):
        to = zone_district(keeper) - 1
        units = [i for i in zones[mover] if plan[i] != to]
        trial = plan[:]
        for i in units:
            trial[i] = to
        # both zoned schools' buildings must end up in the same district (a few buildings sit outside their own zone)
        same = len({trial[school_unit[x]] for x in Z[p["a"]]["dbns"] + Z[p["b"]]["dbns"]}) == 1
        if same and all(connected(dd, trial) for dd in {plan[i] for i in units}) and connected(to, trial):
            cost = students(units)
            if best is None or cost < best[0]:
                best = (cost, mover, keeper, units, trial)
    if best is None:
        p["move"] = None
        continue
    cost, mover, keeper, units, trial = best
    p["move"] = dict(zone=mover, from_district=zone_district(mover), to_district=zone_district(keeper), students=cost)
    plan = trial
    for i in units:
        moved[i] = True

for p in pairs:
    if p["modeled"] and not p.get("move"):
        p["modeled"] = False; p["not_joined"] = True   # no way to join them without splitting a district
modeled = [p for p in pairs if p["modeled"]]
print(f"threshold {TH} pts: {len(Z)} zones with an elementary zoned school, {len(border)} adjacent zone pairs, "
      f"{len(pairs)} pairs meet both tests; {len(cross)} cross a district line; {len(modeled)} non-overlapping cross-district pairs modeled; "
      f"{sum(1 for p in pairs if p.get('not_joined'))} could not be joined, {sum(p['move']['students'] for p in modeled if p.get('move'))} community supt students change district")

json.dump(dict(threshold=TH, zones={z: dict(Z[z], district_major=zone_district(z)) for z in {x for p in pairs for x in (p["a"], p["b"])}}, pairs=pairs),
          open("src/pairs_es.json", "w"))

ALPH = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"
presets = json.load(open("src/presets_es.json"))
today = next(p for p in presets if p["id"] == "current")
ex = dict(today, id="pairs", name="Cross-district zone pairs (25-pt gaps)",
          desc=(f"Today's district lines, redrawn only where needed to pair {len(modeled)} neighboring elementary zones that sit in "
                f"different districts and whose zoned schools differ by {TH:.0f}+ points in both the Black and Hispanic share and the share of "
                f"students in poverty ({len(cross)} such cross-district pairs exist; a school is paired only once). For each pair, one zone "
                "moves into its partner's district (whichever moves fewer students and keeps both districts in one piece), and the two zones "
                "become one shared zone: each school takes on the pair's combined mix."),
          weights=None, plan="".join(ALPH[x] for x in plan),
          pins=[i for i in today.get("pins", []) if i not in moved],
          pairs=[[Z[p["a"]]["dbns"], Z[p["b"]]["dbns"]] for p in modeled],
          pairZones=[[p["a"], p["b"]] for p in modeled])
presets = [p for p in presets if p["id"] != "pairs"]
presets.insert(1, ex)
json.dump(presets, open("src/presets_es.json", "w"))
