"""Geocode each LCGMS building address with NYC DCP GeoSearch (cached)."""
import json, os, sys, urllib.parse, urllib.request, concurrent.futures as cf
import pandas as pd
RAW = sys.argv[1] if len(sys.argv) > 1 else "raw"
cache_p = f"{RAW}/geocode_cache.json"
cache = json.load(open(cache_p)) if os.path.exists(cache_p) else {}
d = pd.read_csv(f"{RAW}/lcgms/lcgms.csv", header=1); d.columns = [c.strip() for c in d.columns]
b = d.drop_duplicates(["Primary Address", "City", "Zip"])
def q(row):
    text = f"{row['Primary Address']}, {row['City']}, NY {str(row['Zip'])[:5]}"
    if text in cache: return text, cache[text]
    url = "https://geosearch.planninglabs.nyc/v2/search?" + urllib.parse.urlencode({"text": text, "size": 1})
    for _ in range(3):
        try:
            r = json.load(urllib.request.urlopen(url, timeout=30))
            f = r["features"]
            if not f: return text, None
            p = f[0]["properties"]
            return text, dict(lon=f[0]["geometry"]["coordinates"][0], lat=f[0]["geometry"]["coordinates"][1],
                              label=p.get("label"), conf=p.get("confidence"), bbl=(p.get("addendum") or {}).get("pad", {}).get("bbl"))
        except Exception as e:
            err = e
    return text, None
with cf.ThreadPoolExecutor(8) as ex:
    for text, res in ex.map(q, [r for _, r in b.iterrows()]):
        cache[text] = res
json.dump(cache, open(cache_p, "w"))
print("buildings", len(b), "geocoded", sum(1 for v in cache.values() if v), "low-confidence", sum(1 for v in cache.values() if v and (v.get("conf") or 0) < 0.8))
