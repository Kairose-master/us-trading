#!/usr/bin/env python3
"""
PyGAD 한 세대 — Node 진화 엔진이 stdin으로 {population, fitness, gene_space, ...}를 주면
PyGAD의 선택(토너먼트)·교차(균등)·변이(gene_space 범위 내 random)를 실제로 돌려
자식 후보를 stdout으로 돌려준다. 적합도는 Node가 실캔들 워크포워드로 이미 계산해
넘긴 값이라 여기서는 조회만 한다 (같은 시험지, 같은 점수).
"""
import json
import sys

import numpy as np
import pygad


def mutate_mode(req: dict) -> None:
    """살아 있는 개체의 자발적 변이 — PyGAD의 random_mutation을 그대로 쓴다 (gene_space 안에서 유전자 일부 치환)."""
    vecs = np.array(req["population"], dtype=float)
    specs = req["gene_space"]
    gene_space = [
        {"low": s["min"], "high": s["max"] + (1 if s["int"] else 0), "step": 1} if s["int"] else {"low": s["min"], "high": s["max"]}
        for s in specs
    ]
    gene_type = [int if s["int"] else float for s in specs]
    ga = pygad.GA(
        num_generations=1, num_parents_mating=2, initial_population=np.vstack([vecs, vecs]) if len(vecs) < 2 else vecs,
        fitness_func=lambda g, sol, i: 0.0, gene_space=gene_space, gene_type=gene_type,
        mutation_type="random", mutation_num_genes=int(req.get("mutation_num_genes", 2)), mutation_by_replacement=True,
        random_seed=int(req.get("seed", 7)), suppress_warnings=True,
    )
    mutated = ga.random_mutation(vecs.copy())
    json.dump({"engine": "pygad", "version": pygad.__version__, "mutated": [[round(float(x), 4) for x in row] for row in mutated],
               "ops": {"mutation": "random", "mutation_num_genes": ga.mutation_num_genes, "by_replacement": True}}, sys.stdout)


def main() -> None:
    req = json.load(sys.stdin)
    if req.get("mode") == "mutate":
        mutate_mode(req)
        return
    pop = np.array(req["population"], dtype=float)
    fit = [float(x) for x in req["fitness"]]
    specs = req["gene_space"]  # [{min,max,int}]
    n_children = int(req.get("num_children", 4))
    seed = int(req.get("seed", 7))
    if len(pop) < 2:
        json.dump({"engine": "pygad", "version": pygad.__version__, "children": [], "note": "population < 2"}, sys.stdout)
        return

    gene_space = [
        {"low": s["min"], "high": s["max"] + (1 if s["int"] else 0), "step": 1} if s["int"] else {"low": s["min"], "high": s["high"] if "high" in s else s["max"]}
        for s in specs
    ]
    gene_type = [int if s["int"] else float for s in specs]
    key_of = lambda row: json.dumps([round(float(x), 4) for x in row])
    table = {key_of(r): f for r, f in zip(pop, fit)}

    def fitness_func(ga, sol, idx):
        # 이미 계산된 점수만 조회 — 새 개체(자식)는 이 세대 안에서 평가되지 않는다 (Node가 다음 세대에 시험 본다)
        return table.get(key_of(sol), min(fit) - 1.0)

    n_parents = max(2, min(len(pop), int(req.get("num_parents", max(2, len(pop) // 2)))))
    ga = pygad.GA(
        num_generations=1,
        num_parents_mating=n_parents,
        initial_population=pop,
        fitness_func=fitness_func,
        gene_space=gene_space,
        gene_type=gene_type,
        parent_selection_type=req.get("parent_selection", "tournament"),
        K_tournament=min(3, len(pop)),
        crossover_type=req.get("crossover", "uniform"),
        mutation_type=req.get("mutation", "random"),
        mutation_percent_genes=int(req.get("mutation_percent_genes", 20)),
        keep_elitism=0,
        keep_parents=0,
        random_seed=seed,
        suppress_warnings=True,
    )
    ga.run()
    # 부모 풀에 없는 새 유전자만 자식 후보 (교차·변이의 결과)
    seen = set(table.keys())
    children = []
    for row in ga.population:
        k = key_of(row)
        if k in seen:
            continue
        seen.add(k)
        children.append([round(float(x), 4) for x in row])
        if len(children) >= n_children:
            break
    # 부모 인덱스(마지막 세대 선택 결과) — pygad는 last_generation_parents_indices를 남긴다
    parents = [int(i) for i in getattr(ga, "last_generation_parents_indices", [])]
    json.dump({"engine": "pygad", "version": pygad.__version__, "children": children, "parents": parents,
               "ops": {"selection": ga.parent_selection_type, "crossover": ga.crossover_type, "mutation": ga.mutation_type, "mutation_percent_genes": ga.mutation_percent_genes}}, sys.stdout)


if __name__ == "__main__":
    main()
