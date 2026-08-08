#!/usr/bin/env python3
"""
skt_candidate_gen.py — real-data dedup candidate-generation against the EXISTING
turbovecdb: extract entity/concept summaries from a wiki, embed via an OpenAI-compat
endpoint (nomic-embed-text), index in turbovecdb, emit candidate duplicate pairs.
Embeddings cached in /tmp/skt_embed_cache.json. See docs/turbovecdb-gaps.md.

Edit PROJ / URL / MODEL constants for your project + embedding endpoint.
"""
import os, glob, re, json, time, tempfile, hashlib, urllib.request
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
import turbovecdb

PROJ="/home/kroussos/stormgiants/stormgiants/Storm King Thunder"
URL="http://192.168.1.147:11434/v1/embeddings"; MODEL="nomic-embed-text"
CACHE="/tmp/skt_embed_cache.json"

def parse_fm(t):
    if not t.startswith("---"): return None,t
    e=t.find("\n---",3)
    if e<0: return None,t
    fm,cur={},None
    for line in t[3:e].splitlines():
        m=re.match(r"^([A-Za-z0-9_]+):\s*(.*)$",line)
        if m:
            k,v=m.group(1),m.group(2).strip()
            if v=="": fm[k]=[]; cur=k
            else: fm[k]=v.strip('"').strip("'"); cur=None
        elif re.match(r"^\s*-\s+",line) and cur:
            fm[cur].append(re.sub(r"^\s*-\s+","",line).strip().strip('"').strip("'"))
    return fm,t[e+4:]
def body_excerpt(b, n=500):
    out=[]
    for l in [x.strip() for x in b.splitlines() if x.strip()]:
        if l.startswith("#") or l.startswith("|") or l.startswith("---"): continue
        out.append(l)
        if sum(len(x) for x in out)>n: break
    return " ".join(out)[:n]

rows={}
for sub,typ in (("wiki/entities","entity"),("wiki/concepts","concept")):
    for f in glob.glob(os.path.join(PROJ,sub,"**","*.md"),recursive=True):
        fm,body=parse_fm(open(f,encoding="utf-8").read())
        if fm is None: continue
        pid=os.path.relpath(f,PROJ); slug=os.path.basename(f)[:-3]
        title=fm.get("title") or slug
        tags=fm.get("tags") if isinstance(fm.get("tags"),list) else []
        desc=fm.get("description") or body_excerpt(body)
        # RICH embed text
        text=f"{typ}: {title}" + (f" [{', '.join(tags)}]" if tags else "") + (f" — {desc}" if desc else "")
        rows[pid]={"pid":pid,"slug":slug,"type":typ,"title":title,"text":text}
rows=list(rows.values())

cache=json.load(open(CACHE)) if os.path.exists(CACHE) else {}
def embed(t):
    h=hashlib.sha1(t.encode()).hexdigest()
    if h in cache: return cache[h]
    req=urllib.request.Request(URL,data=json.dumps({"model":MODEL,"input":t}).encode(),headers={"Content-Type":"application/json"})
    v=json.loads(urllib.request.urlopen(req,timeout=60).read())["data"][0]["embedding"]; cache[h]=v; return v
t0=time.time()
with ThreadPoolExecutor(max_workers=12) as ex: vecs=list(ex.map(lambda r: embed(r["text"]), rows))
json.dump(cache,open(CACHE,"w"))
print(f"pages={len(rows)} embedded in {time.time()-t0:.1f}s (rich text)")

db=turbovecdb.connect(tempfile.mkdtemp(prefix="skt_")); col=db.collection("p",dim=768,create=True)
col.upsert(ids=[r["pid"] for r in rows],vectors=vecs,metadatas=rows)
vById={r["pid"]:v for r,v in zip(rows,vecs)}

t0=time.time(); TAU=0.15; seen=set(); edges=[]
for r,v in zip(rows,vecs):
    q=col.query(vector=v,k=6,where={"pid":{"$ne":r["pid"]}})
    for nid,dist in zip(q.ids,q.distances):
        if dist>TAU: continue
        key=tuple(sorted((r["pid"],nid)))
        if key in seen: continue
        seen.add(key); edges.append((dist,key[0],key[1]))
edges.sort()
print(f"candidate-gen {time.time()-t0:.2f}s; {len(edges)} pairs <= {TAU}\n")
print(f"TOP 25 CLOSEST (rich text, tau={TAU}):")
for d,a,b in edges[:25]: print(f"  {d:.3f}  {a.split('/')[-1]:34s} <-> {b.split('/')[-1]}")

# Ground-truth-ish: same basename as both entity AND concept = likely true dupes
byslug=defaultdict(list)
for r in rows: byslug[r["slug"]].append(r["pid"])
cross=[(s,ps) for s,ps in byslug.items() if len(ps)>1]
print(f"\nKNOWN basename-collisions across type ({len(cross)}): their embedding distance:")
import numpy as np
for s,ps in sorted(cross)[:20]:
    a,b=ps[0],ps[1]
    va,vb=np.asarray(vById[a]),np.asarray(vById[b])
    d=1-float(va@vb/(np.linalg.norm(va)*np.linalg.norm(vb)))
    print(f"  {d:.3f}  {s}")
