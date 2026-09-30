#!/usr/bin/env python3
"""
tvdb_contract_probe.py — exercise the dedup candidate-generation contract against
the EXISTING (unchanged) turbovecdb, with synthetic 768-d vectors. Prints a
PASS/GAP verdict per requirement (R1..R10). See docs/turbovecdb-gaps.md.

Run:  python3 scripts/dedup_prototype/tvdb_contract_probe.py
Deps: turbovecdb (+ turbovec, numpy, filelock) importable on PYTHONPATH.
"""
import time, tempfile
import numpy as np
import turbovecdb

DIM = 768
rng = np.random.default_rng(42)
def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return (v / (np.linalg.norm(v) + 1e-9)).tolist()

results = {}
def check(rid, name, fn):
    try:
        ok, detail = fn()
    except Exception as e:
        ok, detail = False, f"EXC {type(e).__name__}: {e}"
    results[rid] = ok
    print(f"[{rid}] {'PASS' if ok else 'GAP '} {name}\n      {detail}")

dbdir = tempfile.mkdtemp(prefix="tvdb_probe_")
db = turbovecdb.connect(dbdir)
col = db.collection("pages", dim=DIM, create=True)

N = 200
base = {f"entity-{i:03d}": unit(rng.standard_normal(DIM)) for i in range(N)}
a = unit(rng.standard_normal(DIM))
base["vfa"] = a
base["volatile-fatty-acids"] = unit(np.asarray(a) + 0.02 * rng.standard_normal(DIM))
ids = list(base); vecs = [base[i] for i in ids]
metas = [{"slug": i, "type": ("concept" if k % 3 == 0 else "entity")} for k, i in enumerate(ids)]

check("R1/3/4", "upsert BYO-vectors + metadata",
      lambda: (col.upsert(ids=ids, vectors=vecs, metadatas=metas) or True, f"upserted {len(ids)}"))
check("R2/5", "count", lambda: (col.count() == len(ids), f"count={col.count()}"))
check("R7", "exact cosine distance (self≈0)",
      lambda: (dict(zip(*( (col.query(vector=base['vfa'], k=3)).ids, (col.query(vector=base['vfa'], k=3)).distances)))['vfa'] < 1e-3, "self<1e-3"))
def r6():
    q = col.query(vector=base["vfa"], k=4)
    nbrs = [i for i in q.ids if i != "vfa"]
    return (nbrs[:1] == ["volatile-fatty-acids"], f"neighbors={list(zip(q.ids,[round(d,3) for d in q.distances]))}")
check("R6", "planted dupe surfaces as nearest neighbor", r6)
def r8a():
    q = col.query(vector=base["vfa"], k=10, where={"type": "entity"})
    return (all(m.get("type") == "entity" for m in q.metadatas) and q.ids, f"types={set(m.get('type') for m in q.metadatas)}")
check("R8a", "where filter composes with vector search", r8a)
def r8b():
    q = col.query(vector=base["vfa"], k=5, where={"slug": {"$ne": "vfa"}})
    return ("vfa" not in q.ids and q.ids, f"ids={q.ids}")
check("R8b", "self-exclusion via where {$ne} on metadata", r8b)
check("R5-del", "delete by id",
      lambda: (col.delete(ids=["entity-000"]) or col.count() == len(ids) - 1, f"count={col.count()}"))
def r5clear():
    if hasattr(db, "drop_collection"): return (True, "db.drop_collection exists")
    if hasattr(col, "clear"): return (True, "col.clear exists")
    col.delete(where={"slug": {"$ne": "\x00none\x00"}})
    return (col.count() == 0, f"GAP G1: no native clear; delete(where=all)->count={col.count()}")
check("R5-clear", "clear/drop collection", r5clear)
def r10():
    try:
        db.collection("odd", dim=770, create=True).add(ids=["x"], vectors=[unit(rng.standard_normal(770))])
        return (False, "accepted dim=770 (NOT %8)")
    except Exception as e:
        return (True, f"rejected: {type(e).__name__}")
check("R10", "dim%8 constraint", r10)
def r9():
    c = db.collection("scale", dim=DIM, create=True)
    M = 1000
    sids = [f"p{i:04d}" for i in range(M)]
    svecs = [unit(rng.standard_normal(DIM)) for _ in range(M)]
    c.upsert(ids=sids, vectors=svecs, metadatas=[{"slug": s} for s in sids])
    t0 = time.time()
    for s, v in zip(sids, svecs):
        c.query(vector=v, k=5, where={"slug": {"$ne": s}})
    dt = time.time() - t0
    return (dt < 30, f"{M} pages per-page top5 loop = {dt:.2f}s")
check("R9", "candidate-gen latency (1000 pages)", r9)

print("\n===== SUMMARY =====")
for rid, ok in results.items():
    print(f"  {'PASS' if ok else 'GAP '}  {rid}")
