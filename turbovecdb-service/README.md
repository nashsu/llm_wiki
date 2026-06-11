# turbovecdb-service

A thin HTTP layer over the **existing, unchanged** `turbovecdb` vector store,
shaped for llm_wiki's duplicate-detection candidate-generation. Stdlib only
(`http.server` + `json`); the sole third-party import is `turbovecdb` itself.

This is the "plug the existing turbovecdb in and see if it works" layer. It adds
nothing to turbovecdb — gaps the existing core can't do natively are worked around
here and recorded in [`../scripts/dedup_prototype/FINDINGS.md`](../scripts/dedup_prototype/FINDINGS.md)
(G1–G4).

It is the service that `src/lib/dedup-embed.ts` POSTs to during the
"Scan (embeddings)" dedup lane.

## Requirements

The service's only third-party dependency is the [`turbovecdb`](https://github.com/kostadis/turbovecdb)
package, published on PyPI:

```bash
pip install -r requirements.txt   # or: pip install turbovecdb
```

That pulls `turbovecdb` plus its transitive deps (`turbovec`, `numpy`, `filelock`).
Everything else the service uses is Python stdlib. A virtualenv is recommended.

## Run

```bash
python service.py --host 127.0.0.1 --port 8077
```

## API

Per-project data: every request carries an absolute `db_path` (llm_wiki passes
`<project>/.llm-wiki/turbovecdb`). One collection `pages`, one vector per wiki page.

| Route | Body | Returns |
|-------|------|---------|
| `GET /health` | — | `{ok:true}` |
| `POST /upsert` | `{db_path, items:[{id, vector:[float], type?, title?}]}` | `{count}` |
| `POST /candidate_pairs` | `{db_path, threshold, k=6}` | `{pairs:[{a,b,distance,a_title,b_title,a_type,b_type}]}` |
| `POST /count` | `{db_path}` | `{count}` |
| `POST /clear` | `{db_path}` | `{count:0}` |

`candidate_pairs` returns, for every page, its ≤k nearest neighbors with cosine
distance ≤ `threshold` (self excluded), as deduped symmetric edges sorted by
distance. llm_wiki clusters these (union-find) and feeds each cluster to the LLM
duplicate detector.

## Notes / worked-around turbovecdb gaps

- **G2 (duplicate ids in a batch):** `/upsert` pre-dedupes by id (last wins) before
  calling turbovecdb, which otherwise errors `id N already present`.
- **G1 (no native clear):** `/clear` uses `delete(where=all)`.
- Validated: 911 real Storm King rich pages upsert in ~0.4s, candidate_pairs in ~1.8s.
