#!/usr/bin/env python3
"""Optimized LLM inference batching scheduler."""
import json
import math
import os
import sys

HEADS = 32
HIDDEN = 4096
GRAN = 64
MAX_SHAPES = 8

def align(x, g):
    return ((x + g - 1) // g) * g

def load(path):
    reqs = []
    with open(path) as f:
        for line in f:
            reqs.append(json.loads(line))
    return reqs

def pick_shapes(reqs1, reqs2):
    """Pick 8 shapes to cover both buckets, minimizing compile cost."""
    all_seqs = set()
    for r in reqs1 + reqs2:
        all_seqs.add(align(r["prompt_len"], GRAN))
    all_sorted = sorted(all_seqs)

    if len(all_sorted) <= MAX_SHAPES:
        return all_sorted

    # Greedy: keep the most-needed shapes, merge small groups upward
    # Count requests per aligned seq
    from collections import Counter
    counts = Counter()
    for r in reqs1 + reqs2:
        counts[align(r["prompt_len"], GRAN)] += 1

    # Always include the largest (can't round up further)
    must_have = {all_sorted[-1]}
    # Always include the smallest common ones
    # Strategy: pick top shapes by request count, plus the max
    by_count = sorted(all_sorted, key=lambda s: -counts[s])
    selected = set()
    for s in by_count:
        if len(selected) >= MAX_SHAPES:
            break
        selected.add(s)
    # Make sure max is included
    selected.add(all_sorted[-1])
    if len(selected) > MAX_SHAPES:
        # Remove the one with lowest count that isn't the max
        removable = sorted(selected - {all_sorted[-1]}, key=lambda s: counts[s])
        while len(selected) > MAX_SHAPES:
            selected.remove(removable.pop(0))

    return sorted(selected)

def assign_shape(s_needed, shapes_sorted):
    for s in shapes_sorted:
        if s >= s_needed:
            return s
    return shapes_sorted[-1]

def make_plan(reqs, shapes, batch_prefix):
    """Each request gets its own batch. Minimal G_max, minimal padding."""
    shapes_sorted = sorted(shapes)
    plan = []
    for i, r in enumerate(reqs):
        s_needed = align(r["prompt_len"], GRAN)
        s_use = assign_shape(s_needed, shapes_sorted)
        plan.append({
            "request_id": r["request_id"],
            "batch_id": "%s-%04d" % (batch_prefix, i),
            "shape": {
                "seq_align": s_use,
                "heads_align": HEADS,
                "hidden_align": HIDDEN
            }
        })
    return plan

def write_plan(path, plan):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for rec in plan:
            f.write(json.dumps(rec) + "\n")

def main():
    root = "/app/task_file"
    reqs1 = load(os.path.join(root, "input_data", "requests_bucket_1.jsonl"))
    reqs2 = load(os.path.join(root, "input_data", "requests_bucket_2.jsonl"))

    shapes = pick_shapes(reqs1, reqs2)
    print("Selected shapes:", shapes, "count:", len(shapes))

    plan1 = make_plan(reqs1, shapes, "b1")
    plan2 = make_plan(reqs2, shapes, "b2")

    # Verify unique shapes across both
    used = set()
    for p in plan1 + plan2:
        used.add((p["shape"]["seq_align"], p["shape"]["heads_align"], p["shape"]["hidden_align"]))
    print("Unique shapes used:", len(used))
    assert len(used) <= MAX_SHAPES, "Too many shapes!"

    # Verify all requests included
    ids1 = set(r["request_id"] for r in reqs1)
    plan_ids1 = set(p["request_id"] for p in plan1)
    assert ids1 == plan_ids1, "Missing/extra requests in plan1"

    ids2 = set(r["request_id"] for r in reqs2)
    plan_ids2 = set(p["request_id"] for p in plan2)
    assert ids2 == plan_ids2, "Missing/extra requests in plan2"

    write_plan(os.path.join(root, "output_data", "plan_b1.jsonl"), plan1)
    write_plan(os.path.join(root, "output_data", "plan_b2.jsonl"), plan2)
    print("Plans written.")

    # Evaluate
    sys.path.insert(0, os.path.join(root, "scripts"))
    from cost_model import CostModel
    cm = CostModel(GRAN)
    d1 = {r["request_id"]: r for r in reqs1}
    d2 = {r["request_id"]: r for r in reqs2}
    m1 = cm.plan_metrics(d1, plan1)
    m2 = cm.plan_metrics(d2, plan2)

    print("\nB1: cost=%.4e pad=%.4f p95=%.4e seq=%.4e" % (m1["cost"], m1["pad_ratio"], m1["p95_latency_ms"], m1["sequential_timecost"]))
    print("B2: cost=%.4e pad=%.4f p95=%.4e seq=%.4e" % (m2["cost"], m2["pad_ratio"], m2["p95_latency_ms"], m2["sequential_timecost"]))
    print("\nTargets:")
    print("B1: cost<3.0e11 pad<0.055 p95<2.1e6 seq<2.7e8")
    print("B2: cost<4.8e10 pad<0.15  p95<2.1e5 seq<3.2e7")

    # Check pass/fail
    ok = True
    for name, m, targets in [
        ("B1", m1, {"cost": 3.0e11, "pad_ratio": 0.055, "p95_latency_ms": 2.1e6, "sequential_timecost": 2.7e8}),
        ("B2", m2, {"cost": 4.8e10, "pad_ratio": 0.15, "p95_latency_ms": 2.1e5, "sequential_timecost": 3.2e7}),
    ]:
        for k, thresh in targets.items():
            val = m[k]
            status = "PASS" if val <= thresh else "FAIL"
            if status == "FAIL":
                ok = False
            print("%s %s: %.4e vs %.4e -> %s" % (name, k, val, thresh, status))

    if ok:
        print("\nALL PASS!")
    else:
        print("\nSOME FAILED")

if __name__ == "__main__":
    main()
