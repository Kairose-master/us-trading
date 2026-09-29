import json, time, urllib.request, urllib.error, threading, sys, calendar
from concurrent.futures import ThreadPoolExecutor
toks = json.load(open("list_now.json"))
now = time.time() * 1000
sel = sorted([c for c in toks.values() if 1.0 <= (now - c["created_timestamp"]) / 3.6e6 <= 24*14], key=lambda c: -c["created_timestamp"])
print("selected", len(sel), flush=True)
lock = threading.Lock(); out = {}; done = [0]; skipped = [0]
def get(u):
    for i in range(5):
        try:
            with urllib.request.urlopen(u, timeout=20) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(3 + i * 3); continue
            return None
        except Exception: time.sleep(1 + i)
    return None
def work(c):
    m = c["mint"]; created = c["created_timestamp"]; rows = []
    # 실측: 커서 "x-<ms>" 는 그 시각 이전 거래부터 준다 — 생성 후 3시간 창만 받는다
    cur = f"x-{created + 3*3600_000}" if now > created + 3*3600_000 else None
    for page in range(50):
        u = f"https://swap-api.pump.fun/v2/coins/{m}/trades?limit=100" + (f"&cursor={cur}" if cur else "")
        d = get(u)
        if not d or "trades" not in d: break
        for t in d["trades"]:
            ts = calendar.timegm(time.strptime(t["timestamp"][:19], "%Y-%m-%dT%H:%M:%S")) * 1000
            rows.append([ts, t["userAddress"], 1 if t["type"] == "buy" else -1, float(t.get("amountSol") or 0), float(t.get("baseAmount") or 0), float(t.get("priceSol") or 0), t.get("program", ""), t.get("slotIndexId", "")])
        pg = d.get("pagination") or {}
        if not pg.get("hasMore") or not d["trades"]: complete = True; break
        if rows and rows[-1][0] <= created + 1000: complete = True; break
        cur = pg.get("nextCursor"); time.sleep(0.35)
    else:
        complete = False
    with lock:
        done[0] += 1
        if rows and (rows[-1][0] <= created + 5 * 60_000 or not pg.get("hasMore", True)):
            out[m] = {"creator": c.get("creator"), "created": created, "symbol": c.get("symbol"), "complete": c.get("complete"), "twitter": c.get("twitter"), "telegram": c.get("telegram"), "website": c.get("website"), "window_end": (created + 3*3600_000) if now > created + 3*3600_000 else now, "trades": rows[::-1]}
        else: skipped[0] += 1
        if done[0] % 25 == 0:
            print(done[0], "kept", len(out), "skipped", skipped[0], flush=True); json.dump(out, open("trades.json", "w"))
with ThreadPoolExecutor(2) as ex: list(ex.map(work, sel))
json.dump(out, open("trades.json", "w"))
print("saved", len(out), "skipped", skipped[0], flush=True)
