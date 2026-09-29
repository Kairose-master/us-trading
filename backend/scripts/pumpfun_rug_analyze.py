"""러그 분석 — 토큰별 전체 거래(swap-api v2)로 진입 시점 특징과 이후 결과를 잰다.
진입 = 1분봉 종가가 5분 전 대비 +25% 이상 & 최근 5분 중 3분 이상 거래 (토큰당 첫 신호).
라벨: RUG = 진입 후 30분 안에 진입가 대비 -60% 이하 · WIN = 손절(-35%) 전에 +100%.
"""
import json, sys, time, statistics as st, random
from collections import defaultdict

SUPPLY = 1e9
import os
D = {}
for fn in (sys.argv[1:] or ["trades.json", "trades2.json"]):
    if fn.endswith(".json") and os.path.exists(fn): D.update(json.load(open(fn)))
NOW = time.time() * 1000
COST = 0.05

def bars(tr):
    # 1분봉 종가 (거래 없는 분은 직전 종가) + 분별 거래 수
    t0 = tr[0][0] // 60000 * 60000; tend = tr[-1][0] // 60000 * 60000
    by = defaultdict(list)
    for x in tr: by[x[0] // 60000 * 60000].append(x)
    out = []; last = tr[0][5]; t = t0
    while t <= tend:
        xs = by.get(t)
        if xs: last = xs[-1][5]
        out.append((t, last, len(xs) if xs else 0))
        t += 60000
    return out

def entry_index(tr):
    b = bars(tr)
    for i in range(5, len(b)):
        if b[i-5][1] > 0 and b[i][1] / b[i-5][1] >= 1.25 and sum(1 for k in range(i-4, i+1) if b[k][2] > 0) >= 3:
            t_sig = b[i][0] + 60000  # 그 분이 끝난 뒤 첫 거래에 산다
            for j, x in enumerate(tr):
                if x[0] >= t_sig: return j
            return None
    return None

def features(tr, j, meta):
    pre = tr[:j]; t = tr[j][0]; first = tr[0][0]
    net = defaultdict(float); firstbuy = {}; buys = defaultdict(float); sells = defaultdict(float)
    for x in pre:
        w = x[1]; net[w] += x[2] * x[4]
        if x[2] > 0: buys[w] += x[4]; firstbuy.setdefault(w, x[0])
        else: sells[w] += x[4]
    pos = {w: v for w, v in net.items() if v > 0}
    tops = sorted(pos.values(), reverse=True)
    cr = meta.get("creator")
    creator_pct = max(0.0, net.get(cr, 0.0)) / SUPPLY * 100 if cr else None
    creator_sold = (sells.get(cr, 0) / buys[cr]) if cr and buys.get(cr) else 0.0
    creator_first_sol = next((x[3] for x in pre if x[1] == cr and x[2] > 0), 0.0) if cr else 0.0
    early3 = {w for w, ts in firstbuy.items() if ts - first <= 3000}
    early60 = {w for w, ts in firstbuy.items() if ts - first <= 60000}
    rec = [x for x in pre if x[0] >= t - 300000]
    rb = [x for x in rec if x[2] > 0]
    buy_sol_by = defaultdict(float)
    for x in rb: buy_sol_by[x[1]] += x[3]
    bs = sorted(buy_sol_by.values(), reverse=True); tot_b = sum(bs) or 1e-9
    return {
        "age_min": (t - meta["created"]) / 60000,
        "mcap_sol": tr[j][5] * SUPPLY,
        "graduated": 0 if tr[j][6] in ("pump", "pump_fun", "pumpfun", "bonding_curve") else 1,
        "creator_pct": creator_pct if creator_pct is not None else -1,
        "creator_sold_frac": creator_sold,
        "creator_first_sol": creator_first_sol,
        "top1_pct": (tops[0] / SUPPLY * 100) if tops else 0,
        "top10_pct": sum(tops[:10]) / SUPPLY * 100,
        "holders": sum(1 for v in pos.values() if v / SUPPLY >= 1e-4),
        "bundle3s_pct": sum(max(0, net[w]) for w in early3) / SUPPLY * 100,
        "bundle3s_n": len(early3),
        "snipers60_pct": sum(max(0, net[w]) for w in early60) / SUPPLY * 100,
        "uniq_buyers5m": len(buy_sol_by),
        "trades_per_wallet5m": len(rec) / max(1, len({x[1] for x in rec})),
        "top3_buy_share5m": sum(bs[:3]) / tot_b,
        "sell_ratio5m": sum(1 for x in rec if x[2] < 0) / max(1, len(rec)),
        "socials": int(bool(meta.get("twitter"))) + int(bool(meta.get("telegram"))) + int(bool(meta.get("website"))),
    }

def outcome(tr, j):
    e = tr[j][5] * 1.01  # 매수 슬리피지 1%
    t0 = tr[j][0]; rug = False; win = False; mfe = 0; stopped = False; mdd = 0
    for x in tr[j+1:]:
        if x[0] - t0 > 120 * 60000: break
        r = x[5] / e - 1
        mdd = min(mdd, r)
        if x[0] - t0 <= 30 * 60000 and r <= -0.6: rug = True
        if not stopped:
            mfe = max(mfe, r)
            if r >= 1.0: win = True
            if r <= -0.35: stopped = True
    observed = min(tr[-1][0], NOW) - t0  # 거래가 끊긴 토큰도 '지금'까지 관측된 것으로 본다(죽은 것)
    return {"rug": rug, "win": win, "mfe": mfe, "mdd": mdd, "obs_min": (NOW - t0) / 60000}

def sim(tr, j, extra_exit=None):
    """현재 정책 근사(거래 단위): 러그 감시 90초 -50%, 손절 -35, 사다리 +100(34%)/+400(25%), +100 후 고점 -40 되돌림, 120분 시간정지(+30 미만).
    extra_exit(x, ctx) 가 True 면 그 다음 거래 가격(-2% 슬리피지)으로 전량 청산."""
    e = tr[j][5] * 1.01; t0 = tr[j][0]; pos = 1.0; got = 0.0; peak = e; done = set(); hist = []
    ctx = {"t0": t0, "pre": tr[:j], "entry": e, "sold": defaultdict(float)}
    k = j + 1
    while k < len(tr):
        x = tr[k]; px = x[5]; age = x[0] - t0
        if age > 360 * 60000: break
        hist.append((x[0], px)); hist = [h for h in hist if x[0] - h[0] <= 90000]
        if extra_exit and extra_exit(x, ctx):
            nxt = tr[k+1][5] if k + 1 < len(tr) else px
            got += pos * nxt * 0.98 / e; pos = 0; break
        if hist and hist[0][1] > 0 and px <= 0.5 * max(h[1] for h in hist): got += pos * px / e; pos = 0; break
        if px <= e * 0.65: got += pos * px / e; pos = 0; break
        for at, fr in ((1.0, .34), (4.0, .25)):
            if at not in done and px >= e * (1 + at): s = min(pos, fr); got += s * px / e; pos -= s; done.add(at)
        peak = max(peak, px)
        if peak >= e * 2 and px <= peak * 0.6: got += pos * px / e; pos = 0; break
        if age >= 120 * 60000 and px < e * 1.3: got += pos * px / e; pos = 0; break
        k += 1
    if pos > 0: got += pos * tr[min(k, len(tr) - 1)][5] / e
    return got - 1 - COST

rows = []
for m, d in D.items():
    tr = [x for x in d["trades"] if x[5] > 0]
    if len(tr) < 30: continue
    j = entry_index(tr)
    if j is None: continue
    o = outcome(tr, j)
    wend = d.get("window_end", NOW)
    if (wend - tr[j][0]) / 60000 < 60: continue  # 진입 후 60분을 못 보면 제외 (러그는 대개 수십 분 안)
    f = features(tr, j, d)
    rows.append({"mint": m, **f, **o, "pnl": sim(tr, j), "_tr": tr, "_j": j, "_meta": d})

n = len(rows)
print(f"토큰 {len(D)} · 진입 신호 {n}")
if not n: sys.exit()
print(f"러그(30분 내 -60%) {sum(r['rug'] for r in rows)/n*100:.1f}% · 대박(손절 전 +100%) {sum(r['win'] for r in rows)/n*100:.1f}% · 현재 정책 평균 {st.mean(r['pnl'] for r in rows)*100:+.1f}% 중앙값 {st.median(r['pnl'] for r in rows)*100:+.1f}%")

def table(key, cuts, fmt="{:.1f}"):
    print(f"\n[{key}]  구간 | n | 러그% | 대박% | 평균손익")
    edges = [-1e18] + cuts + [1e18]
    for lo, hi in zip(edges, edges[1:]):
        sub = [r for r in rows if lo <= r[key] < hi]
        if not sub: continue
        lab = f"{'' if lo == -1e18 else fmt.format(lo)}~{'' if hi == 1e18 else fmt.format(hi)}"
        print(f"  {lab:>14} | {len(sub):3d} | {sum(r['rug'] for r in sub)/len(sub)*100:5.1f} | {sum(r['win'] for r in sub)/len(sub)*100:5.1f} | {st.mean(r['pnl'] for r in sub)*100:+6.1f}%")

if True:
    table("creator_pct", [0.01, 2, 5, 10])
    table("creator_sold_frac", [0.01, 0.5, 0.99], "{:.2f}")
    table("creator_first_sol", [0.5, 1, 2, 5])
    table("top1_pct", [3, 5, 8, 12, 20])
    table("top10_pct", [15, 25, 35, 50])
    table("bundle3s_pct", [0.5, 3, 8, 15])
    table("snipers60_pct", [2, 8, 15, 30])
    table("holders", [30, 60, 120, 250], "{:.0f}")
    table("uniq_buyers5m", [5, 10, 20, 40], "{:.0f}")
    table("trades_per_wallet5m", [1.5, 2, 3, 5])
    table("top3_buy_share5m", [0.3, 0.5, 0.7, 0.9], "{:.2f}")
    table("sell_ratio5m", [0.2, 0.35, 0.5], "{:.2f}")
    table("age_min", [5, 15, 60, 240], "{:.0f}")
    table("mcap_sol", [30, 60, 120, 400], "{:.0f}")
    table("graduated", [1], "{:.0f}")
    table("socials", [1, 2, 3], "{:.0f}")

json.dump([{k: v for k, v in r.items() if not k.startswith("_")} for r in rows], open("rug_rows.json", "w"))

# ===== 청산 쪽: 러그 직전 누가 팔았나 + 매도 감시 규칙 =====
def holders_at(pre):
    net = defaultdict(float); first = pre[0][0] if pre else 0; fb = {}
    for x in pre:
        net[x[1]] += x[2] * x[4]
        if x[2] > 0: fb.setdefault(x[1], x[0])
    return net, fb, first

def rule(kind, pct_holder=1.0, frac=0.5, whale_pct=2.0):
    def f(x, ctx):
        if "net" not in ctx:
            net, fb, first = holders_at(ctx["pre"]); ctx["net"] = net
            ctx["big"] = {w for w, v in net.items() if v / SUPPLY * 100 >= pct_holder}
            ctx["bundle"] = {w for w, ts in fb.items() if ts - first <= 3000 and net[w] > 0}
            ctx["creator"] = ctx.get("creator")
        if x[2] > 0: return False
        w = x[1]; ctx["sold"][w] += x[4]
        if kind in ("creator", "all") and ctx.get("creator") and w == ctx["creator"]: return True
        if kind in ("big", "all") and w in ctx["big"] and ctx["sold"][w] >= frac * ctx["net"][w]: return True
        if kind in ("bundle", "all") and w in ctx["bundle"] and ctx["sold"][w] >= frac * ctx["net"][w]: return True
        if kind in ("whale", "all") and x[4] / SUPPLY * 100 >= whale_pct: return True
        return False
    return f

def sim_with(r, fn):
    tr, j = r["_tr"], r["_j"]
    def wrapped(x, ctx):
        ctx.setdefault("creator", r["_meta"].get("creator"))
        return fn(x, ctx)
    return sim(tr, j, wrapped)

print("\n===== 청산 규칙 (현재 정책 + 감시 매도 → 다음 거래가 -2% 로 전량) =====")
print(f"  {'규칙':44s} 전체평균  러그평균  대박평균  대박중 조기청산")
base = {id(r): r["pnl"] for r in rows}
rugs = [r for r in rows if r["rug"]]; wins = [r for r in rows if r["win"]]
def show(name, fn):
    P = {id(r): (sim_with(r, fn) if fn else r["pnl"]) for r in rows}
    cut = sum(1 for r in wins if fn and P[id(r)] < base[id(r)] - 0.05)
    print(f"  {name:44s} {st.mean(P.values())*100:+7.1f}% {st.mean(P[id(r)] for r in rugs)*100 if rugs else 0:+8.1f}% {st.mean(P[id(r)] for r in wins)*100 if wins else 0:+8.1f}%   {cut}/{len(wins)}")
show("현재 정책", None)
show("+ 개발자가 팔면", rule("creator"))
for ph in (1.0, 2.0, 4.0):
    for fr in (0.3, 0.5):
        show(f"+ 진입 때 ≥{ph}% 홀더가 보유 {int(fr*100)}% 이상 팔면", rule("big", ph, fr))
show("+ 번들(생성 3초 내) 지갑이 절반 팔면", rule("bundle", frac=0.5))
for wp in (1.0, 2.0, 3.0):
    show(f"+ 한 번에 공급 {wp}% 이상 매도", rule("whale", whale_pct=wp))
show("+ 전부(개발자·≥2%홀더 50%·번들·2% 단일)", rule("all", 2.0, 0.5, 2.0))

# 러그 해부 — 폭락 구간의 최대 매도자는 누구였나
print("\n===== 러그 해부 (진입 후 30분 내 -60%) =====")
for r in rugs[:40]:
    tr, j = r["_tr"], r["_j"]; e = tr[j][5]; net, fb, first = holders_at(tr[:j]); cr = r["_meta"].get("creator")
    k = next((k for k in range(j + 1, len(tr)) if tr[k][5] <= e * 0.4), None)
    if k is None: continue
    win = [x for x in tr[j+1:k+1] if x[2] < 0]
    if not win: continue
    big = max(win, key=lambda x: x[4])
    who = "개발자" if big[1] == cr else ("번들" if fb.get(big[1], 1e18) - first <= 3000 else ("진입때홀더" if net.get(big[1], 0) > 0 else "진입후매수자"))
    secs = (tr[k][0] - tr[j][0]) / 1000
    print(f"  {r['mint'][:6]} -60%까지 {secs:6.0f}s · 최대매도 {big[4]/SUPPLY*100:5.2f}% 공급 ({who}, 진입때 보유 {max(0,net.get(big[1],0))/SUPPLY*100:.2f}%) · 매도 {len(win)}건 · 개발자% {r['creator_pct']:.1f} top10 {r['top10_pct']:.0f} 번들 {r['bundle3s_pct']:.1f}")
