import sys
sys.argv = ["rug.py", "trades.json"]
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf): exec(open(__file__.replace("pumpfun_rug_rules.py", "pumpfun_rug_analyze.py")).read())
import statistics as st
# 진입 필터 후보
def filt(r, c):
    return (r["creator_pct"] > c.get("cr", 1e9) or r["top10_pct"] > c.get("t10", 1e9) or r["bundle3s_pct"] > c.get("bun", 1e9)
            or r["snipers60_pct"] > c.get("snp", 1e9) or r["trades_per_wallet5m"] > c.get("tpw", 1e9) or r["holders"] > c.get("hold", 1e9))
print("진입 필터 | 남은 n | 막은 러그 | 막은 대박 | 남은 평균")
for name, c in [("없음", {}), ("극단만: 개발자>10 상위10>50 번들>15 스나이퍼>30 지갑당>5", dict(cr=10, t10=50, bun=15, snp=30, tpw=5)),
                ("극단 + 홀더>120", dict(cr=10, t10=50, bun=15, snp=30, tpw=5, hold=120)),
                ("번들>8 스나이퍼>30", dict(bun=8, snp=30))]:
    keep = [r for r in rows if not filt(r, c)]; blk = [r for r in rows if filt(r, c)]
    print(f"  {name:52s} {len(keep):3d} | {sum(r['rug'] for r in blk)}/{sum(r['rug'] for r in rows)} | {sum(r['win'] for r in blk)}/{sum(r['win'] for r in rows)} | {st.mean(r['pnl'] for r in keep)*100:+.1f}%")
# 구현할 감시 조합
def combo(ph, fr, bundle, whale):
    def f(x, ctx):
        if "net" not in ctx:
            net, fb, first = holders_at(ctx["pre"]); ctx["net"] = net
            ctx["watch"] = {w for w, v in net.items() if v > 0 and (w == ctx.get("creator") or v / SUPPLY * 100 >= ph or (bundle and fb.get(w, 1e18) - first <= 3000))}
        if x[2] > 0: return False
        w = x[1]; ctx["sold"][w] += x[4]
        if whale and x[4] / SUPPLY * 100 >= whale: return True
        if ctx.get("creator") and w == ctx["creator"]: return True
        return w in ctx["watch"] and ctx["sold"][w] >= fr * ctx["net"][w]
    return f
keep = [r for r in rows if not filt(r, dict(cr=10, t10=50, bun=15, snp=30, tpw=5))]
print("\n감시 조합 (극단 필터 통과분 기준) | 평균 | 러그평균 | 대박평균")
for name, args in [("현재 정책만", None), ("개발자", (1e9, 1, False, 0)), ("개발자+≥2%홀더 50%", (2, .5, False, 0)), ("개발자+≥2%홀더 30%", (2, .3, False, 0)),
                   ("개발자+≥2%홀더 50%+번들 50%", (2, .5, True, 0)), ("개발자+≥3%홀더 50%", (3, .5, False, 0))]:
    P = [sim_with(r, combo(*args)) if args else r["pnl"] for r in keep]
    R = [p for p, r in zip(P, keep) if r["rug"]]; W = [p for p, r in zip(P, keep) if r["win"]]
    print(f"  {name:30s} {st.mean(P)*100:+6.1f}% {st.mean(R)*100 if R else 0:+7.1f}% {st.mean(W)*100 if W else 0:+7.1f}%  (n={len(P)}, 러그 {len(R)}, 대박 {len(W)})")
