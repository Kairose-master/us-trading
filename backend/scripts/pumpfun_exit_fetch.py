import json, time, urllib.request, os
def get(u):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(u), timeout=15) as r: return json.load(r)
        except Exception as e:
            time.sleep(1.5)
    return None
mints = {}
for off in range(0, 600, 50):
    d = get(f"https://frontend-api-v3.pump.fun/coins?offset={off}&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=true")
    if not isinstance(d, list) or not d: break
    for c in d: mints[c["mint"]] = {"symbol": c.get("symbol"), "complete": c.get("complete"), "created": c.get("created_timestamp")}
    time.sleep(0.4)
print("tokens", len(mints))
out = {}
for i, (m, meta) in enumerate(mints.items()):
    d = get(f"https://swap-api.pump.fun/v1/coins/{m}/candles?interval=1m&limit=1000")
    if isinstance(d, list) and d: out[m] = {**meta, "c": [[x["timestamp"], float(x["open"]), float(x["high"]), float(x["low"]), float(x["close"]), float(x["volume"])] for x in d]}
    time.sleep(0.25)
    if i % 100 == 0: print(i, len(out), flush=True)
json.dump(out, open(os.environ.get("OUT", "candles.json"), "w"))
print("saved", len(out))
