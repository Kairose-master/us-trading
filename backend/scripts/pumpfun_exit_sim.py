import json, statistics as st, time
D = json.load(open("candles.json"))
NOW = time.time()*1000
COST = 0.05  # 왕복 수수료+슬리피지
HOLD_CAP = 360

def series(c):
    # 분 단위 연속 시계열 (거래 없는 분은 직전 종가로 평탄)
    c = sorted(c); t0 = c[0][0]; tend = max(c[-1][0], NOW - 60_000)
    by = {x[0]: x for x in c}; out = []; last = None; t = t0
    while t <= tend:
        if t in by: _, o, h, l, cl, v = by[t]; last = cl; out.append((t, o, h, l, cl, v))
        else: out.append((t, last, last, last, last, 0.0))
        t += 60_000
    return out

def entries(s, thr):
    for i in range(6, len(s) - 1):
        if s[i-5][4] > 0 and s[i][4] / s[i-5][4] >= 1 + thr and sum(1 for k in range(i-4, i+1) if s[k][5] > 0) >= 3:
            if s[i+1][0] > NOW - 120*60_000: return None  # 미래 120분이 안 보이면 제외
            return i + 1
    return None

def run(s, e, pol):
    ent = s[e][1]; pos = 1.0; realized = 0.0; peak = ent; done = set()
    def sell(frac, px):
        nonlocal pos, realized
        f = min(frac, pos); realized += f * (px / ent); pos -= f
    for k in range(e, min(len(s), e + HOLD_CAP)):
        t, o, h, l, c, v = s[k]; age = k - e
        # 1) 러그 급락: 1~2분 전 종가 대비 -50%
        if pol.get("crash") and k - 2 >= e and c <= 0.5 * max(s[k-1][4], s[k-2][4]): sell(pos, c); break
        # 2) 손절 (보수적으로 같은 봉에선 손절 먼저)
        sl = ent * (1 - pol["stop"]/100)
        if l <= sl: sell(pos, min(o, sl)); break
        # 3) 사다리
        for at, frac in pol.get("ladder", []):
            if at not in done and h >= ent * (1 + at/100): sell(frac if frac < 1 else pos, ent*(1+at/100)); done.add(at)
        if pos <= 1e-9: break
        peak = max(peak, h); peakpct = (peak/ent - 1) * 100
        # 4) 되돌림
        ta = pol.get("trailAct")
        if ta is not None and peakpct >= ta and l <= peak * (1 - pol["trail"]/100): sell(pos, peak * (1 - pol["trail"]/100)); break
        # 5) 모멘텀 소멸 (시장 5분 고점 대비)
        if pol.get("fade"):
            p5 = max(x[2] for x in s[max(e, k-4):k+1]); pnl = (c/ent - 1)*100
            if c <= p5 * (1 - (40 if pnl >= 100 else 25)/100): sell(pos, c); break
        # 6) 시간 정지
        if age >= pol.get("tmax", 120) and (c/ent - 1)*100 < pol.get("texempt", 30): sell(pos, c); break
    else:
        pass
    if pos > 1e-9: sell(pos, s[min(len(s)-1, e + HOLD_CAP - 1)][4])
    return realized - 1 - COST

P = {
 "현재(사다리+100/+400, 되돌림 +100후 -40, 5분고점 -25 청산)": dict(stop=35, crash=1, ladder=[(100,.34),(400,.25)], trailAct=100, trail=40, fade=1),
 "현재에서 5분고점 청산만 뺌":                                dict(stop=35, crash=1, ladder=[(100,.34),(400,.25)], trailAct=100, trail=40, fade=0),
 "A: +30%에 50% 익절, 나머지 +30후 고점-30 되돌림":           dict(stop=35, crash=1, ladder=[(30,.5)], trailAct=30, trail=30, fade=1),
 "B: +50%에 40%, +100%에 30%, 나머지 +50후 -35 되돌림":        dict(stop=35, crash=1, ladder=[(50,.4),(100,.3)], trailAct=50, trail=35, fade=1),
 "C: +30% 전량 익절":                                          dict(stop=35, crash=1, ladder=[(30,1)], fade=1),
 "D: +50% 전량 익절":                                          dict(stop=35, crash=1, ladder=[(50,1)], fade=1),
 "E: +20% 넘으면 고점-25 되돌림 (익절 없음)":                  dict(stop=35, crash=1, trailAct=20, trail=25, fade=1),
 "F: +50%에 50%, 나머지 +50후 고점-30 되돌림":                 dict(stop=35, crash=1, ladder=[(50,.5)], trailAct=50, trail=30, fade=1),
}
for thr in (0.25, 0.5):
    rows = []
    for m, d in D.items():
        if len(d["c"]) < 20: continue
        s = series(d["c"]); e = entries(s, thr)
        if e is None: continue
        ent = s[e][1]; w = s[e:e+HOLD_CAP]
        # 손절(-35) 전에 도달한 최고 상승폭
        mfe = 0
        for x in w:
            if x[3] <= ent*0.65: break
            mfe = max(mfe, (x[2]/ent-1)*100)
        rows.append((m, s, e, mfe))
    n = len(rows)
    print(f"\n===== 진입: 5분 +{int(thr*100)}% 급등 직후 (토큰당 첫 신호) · 표본 {n} =====")
    for lv in (30, 50, 100, 200, 400):
        print(f"  손절 전에 +{lv}% 도달: {sum(1 for r in rows if r[3] >= lv)/n*100:5.1f}%")
    print(f"  {'정책':58s} 평균    중앙값  승률")
    for name, pol in P.items():
        R = [run(s, e, pol) for _, s, e, _ in rows]
        print(f"  {name:58s} {st.mean(R)*100:+6.1f}% {st.median(R)*100:+6.1f}% {sum(1 for r in R if r > 0)/n*100:4.0f}%")

print("\n===== 생존편향 민감도: 5분 +25% 진입, 대박(손절 전 최고 상승폭) 상위 x% 제거 후 평균 =====")
thr = 0.25
rows = []
for m, d in D.items():
    if len(d["c"]) < 20: continue
    s = series(d["c"]); e = entries(s, thr)
    if e is None: continue
    ent = s[e][1]; mfe = 0
    for x in s[e:e+HOLD_CAP]:
        if x[3] <= ent*0.65: break
        mfe = max(mfe, (x[2]/ent-1)*100)
    rows.append((s, e, mfe))
rows.sort(key=lambda r: -r[2])
print(f"  {'정책':58s} " + "  ".join(f"상위{p:>2d}%제거" for p in (0, 5, 10, 20, 30)))
for name, pol in P.items():
    cells = []
    for p in (0, 5, 10, 20, 30):
        sub = rows[int(len(rows)*p/100):]
        cells.append(f"{st.mean([run(s, e, pol) for s, e, _ in sub])*100:+8.1f}%")
    print(f"  {name:58s} " + "  ".join(cells))
