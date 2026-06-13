#!/usr/bin/env python3
"""
turbovecdb-service — a thin HTTP layer over the EXISTING (unchanged) turbovecdb,
shaped for llm_wiki's dedup candidate-generation. Stdlib only (http.server + json);
the only third-party import is turbovecdb itself.

This is the "plug the existing turbovecdb in and see if it works" layer — it adds
NOTHING to turbovecdb; everything turbovecdb can't do natively is worked around here
and noted in llm_wiki's scripts/dedup_prototype/FINDINGS.md (gaps G1–G4).

Per-project data: every request carries an absolute `db_path` (e.g.
<project>/.llm-wiki/turbovecdb); the service does turbovecdb.connect(db_path) and uses
a single collection "pages" (one vector per wiki page).

Endpoints (all POST, JSON in/out; GET /health):
  POST /upsert          {db_path, items:[{id, vector:[float], type?, title?}]}  -> {count}
  POST /candidate_pairs {db_path, threshold, k=6}  -> {pairs:[{a,b,distance,a_title,b_title,a_type,b_type}]}
  POST /count           {db_path}  -> {count}
  POST /clear           {db_path}  -> {count:0}

Run:  python3 service.py [--host 127.0.0.1] [--port 8077]
"""
from __future__ import annotations
import argparse, json, threading
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import turbovecdb

COLLECTION = "pages"

# One lock per db_path: turbovecdb is multi-process safe, but we serialize
# same-DB access within this process to avoid concurrent-writer surprises.
_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
_locks_guard = threading.Lock()

def _lock_for(db_path: str) -> threading.Lock:
    with _locks_guard:
        return _locks[db_path]

def _open(db_path: str, dim: int | None = None, create: bool = False):
    db = turbovecdb.connect(db_path)
    if not create and COLLECTION not in db.list_collections():
        return db, None
    col = db.collection(COLLECTION, dim=dim, create=True)
    return db, col


def op_upsert(req: dict) -> dict:
    db_path = req["db_path"]
    items = req.get("items", [])
    if not items:
        return {"count": 0}
    # Work around turbovecdb gap G2: it errors on duplicate ids within one
    # batch instead of deduping. Pre-dedupe by id (last wins).
    by_id: dict[str, dict] = {}
    for it in items:
        by_id[it["id"]] = it
    items = list(by_id.values())
    dim = len(items[0]["vector"])
    with _lock_for(db_path):
        db, col = _open(db_path, dim=dim, create=True)
        col.upsert(
            ids=[it["id"] for it in items],
            vectors=[it["vector"] for it in items],
            metadatas=[
                {"pid": it["id"], "type": it.get("type", ""), "title": it.get("title", "")}
                for it in items
            ],
        )
        return {"count": col.count()}


def op_candidate_pairs(req: dict) -> dict:
    db_path = req["db_path"]
    tau = float(req.get("threshold", 0.15))
    k = int(req.get("k", 6))
    with _lock_for(db_path):
        db, col = _open(db_path)
        if col is None or col.count() == 0:
            return {"pairs": []}
        allrows = col.get(include=["metadatas", "vectors"])
        ids = allrows.ids
        vecs = allrows.vectors
        metas = allrows.metadatas
        meta_by_id = {pid: m for pid, m in zip(ids, metas)}
        seen: set[tuple[str, str]] = set()
        pairs = []
        for pid, v in zip(ids, vecs):
            q = col.query(vector=v, k=k + 1, where={"pid": {"$ne": pid}})
            for nid, dist in zip(q.ids, q.distances):
                if dist > tau:
                    continue
                key = tuple(sorted((pid, nid)))
                if key in seen:
                    continue
                seen.add(key)
                ma, mb = meta_by_id.get(key[0], {}), meta_by_id.get(key[1], {})
                pairs.append({
                    "a": key[0], "b": key[1], "distance": round(float(dist), 5),
                    "a_title": ma.get("title", ""), "b_title": mb.get("title", ""),
                    "a_type": ma.get("type", ""), "b_type": mb.get("type", ""),
                })
        pairs.sort(key=lambda p: p["distance"])
        return {"pairs": pairs}


def op_count(req: dict) -> dict:
    with _lock_for(req["db_path"]):
        db, col = _open(req["db_path"])
        return {"count": 0 if col is None else col.count()}


def op_clear(req: dict) -> dict:
    db_path = req["db_path"]
    with _lock_for(db_path):
        db, col = _open(db_path)
        if col is None:
            return {"count": 0}
        # Work around gap G1 (no native clear): delete-by-where-all.
        col.delete(where={"pid": {"$ne": "\x00__none__\x00"}})
        return {"count": col.count()}


ROUTES = {
    "/upsert": op_upsert,
    "/candidate_pairs": op_candidate_pairs,
    "/count": op_count,
    "/clear": op_clear,
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        fn = ROUTES.get(self.path)
        if fn is None:
            self._send(404, {"error": f"unknown route {self.path}"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            self._send(200, fn(req))
        except Exception as e:  # surface every failure to the caller
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, *a):  # quieter logs
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8077)
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"turbovecdb-service on http://{args.host}:{args.port}  (collection='{COLLECTION}')")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
