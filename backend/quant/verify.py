#!/usr/bin/env python3
"""
검증 사이드카 — 우리가 직접 짤 이유가 없는 두 검정을 arch(Kevin Sheppard)에 맡긴다.

  spa   Hansen의 Superior Predictive Ability (White의 Reality Check 개선판).
        "N개 후보 중 최고가 벤치마크보다 나은 것이 데이터 스누핑으로 설명되는가"의 p값.
        scanner.ts가 이미 적어 둔 "30개 코인을 훑은 것 자체가 30번의 암묵적 검정"의 계산부다.
  stepm Romano-Wolf. p값 대신 **벤치마크를 실제로 이긴 모델의 집합**을 준다 (FWER 통제).

입력은 stdin JSON, 출력은 stdout JSON 한 줄. 손실(loss)은 작을수록 좋다 → 수익률의 음수.
arch가 없으면 TS 쪽(verify.ts)이 engine:"unavailable"로 받고 숫자를 지어내지 않는다.
"""
import json
import sys


def main() -> int:
    try:
        req = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"bad request json: {e}"}))
        return 1

    op = req.get("op", "ping")
    try:
        import numpy as np
        import arch
        from arch.bootstrap import SPA, StepM
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"arch unavailable: {e}"}))
        return 1

    if op == "ping":
        print(json.dumps({"engine": "arch", "version": arch.__version__}))
        return 0

    if op != "spa":
        print(json.dumps({"error": f"unknown op: {op}"}))
        return 1

    names = list(req["models"].keys())
    if not names:
        print(json.dumps({"error": "no models"}))
        return 1
    bench = np.asarray(req["benchmark"], dtype=float)
    losses = np.column_stack([np.asarray(req["models"][n], dtype=float) for n in names])
    if losses.shape[0] != bench.shape[0]:
        print(json.dumps({"error": f"length mismatch: benchmark {bench.shape[0]} vs models {losses.shape[0]}"}))
        return 1
    n = int(bench.shape[0])
    if n < 30:
        print(json.dumps({"error": f"need at least 30 observations, got {n}"}))
        return 1

    reps = int(req.get("reps", 1000))
    block = int(req.get("blockSize", max(2, min(30, round(n ** (1 / 3))))))
    seed = int(req.get("seed", 11))

    spa = SPA(bench, losses, reps=reps, block_size=block, seed=seed)
    spa.compute()
    p = spa.pvalues  # lower / consistent / upper

    # 평균 손실 차이 (음수 = 벤치마크보다 손실이 작다 = 더 좋다)
    diff = (losses.mean(axis=0) - bench.mean()).tolist()
    best = int(np.argmin(losses.mean(axis=0)))

    superior = []
    try:
        sm = StepM(bench, losses, size=0.05, reps=reps, block_size=block, seed=seed)
        sm.compute()
        # StepM.superior_models는 열 이름(pandas) 또는 인덱스를 준다
        for s in sm.superior_models:
            superior.append(names[s] if isinstance(s, (int,)) else str(s))
    except Exception as e:  # noqa: BLE001
        superior = None

    print(json.dumps({
        "engine": "arch",
        "version": arch.__version__,
        "n": n,
        "models": len(names),
        "reps": reps,
        "blockSize": block,
        "pvalues": {k: (None if v != v else float(v)) for k, v in dict(p).items()},
        "best": {"name": names[best], "meanLossDiff": float(diff[best])},
        "meanLossDiff": {names[i]: float(d) for i, d in enumerate(diff)},
        "superiorModels": superior,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
