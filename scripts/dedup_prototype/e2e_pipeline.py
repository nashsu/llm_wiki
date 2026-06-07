#!/usr/bin/env python3
"""
e2e_pipeline.py — end-to-end validation of the rich-page dedup pipeline that
src/lib/dedup-embed.ts implements: rich pages -> live turbovecdb-service candidate
pairs -> union-find clusters -> bounded batches -> LLM detector confirm -> groups.
Requires: the turbovecdb-service running (SVC), an OpenAI-compat chat endpoint (LLM),
and the embedding cache from skt_candidate_gen.py. Edit the constants for your setup.
"""
import os, glob, re, json, hashlib, tempfile, urllib.request, time
PROJ="/home/kroussos/stormgiants/stormgiants/Storm King Thunder"; CACHE="/tmp/skt_embed_cache.json"
SVC="http://127.0.0.1:8077"; LLM="http://192.168.1.147:8001/v1/chat/completions"; MODEL="Qwen/Qwen3-Next-80B-A3B-Instruct-FP8"
cache=json.load(open(CACHE)); sha=lambda t: hashlib.sha1(t.encode()).hexdigest()
SYS=re.search(r"const DETECTOR_SYSTEM_PROMPT = `(.+?)`", open("/home/kroussos/src/llmwiki/llm_wiki/src/lib/dedup.ts").read(), re.S).group(1).replace("\\`","`").replace("\\$","$")
def parse(p):
    t=open(p,encoding="utf-8").read(); fm={}; body=t
    if t.startswith("---"):
        e=t.find("\n---",3)
        if e>=0:
            body=t[e+4:]; cur=None
            for line in t[3:e].splitlines():
                m=re.match(r"^([A-Za-z0-9_]+):\s*(.*)$",line)
                if m:
                    k,v=m.group(1),m.group(2).strip()
                    if v=="": fm[k]=[]; cur=k
                    else: fm[k]=v.strip('"').strip("'"); cur=None
                elif re.match(r"^\s*-\s+",line) and cur is not None: fm[cur].append(re.sub(r"^\s*-\s+","",line).strip().strip('"').strip("'"))
    return fm,body
def prose(b): return " ".join(l.strip() for l in b.splitlines() if l.strip() and l.strip()[0] not in "#|>-*" and not l.strip().startswith("---"))
def firstpara(b):
    for l in [x.strip() for x in b.splitlines() if x.strip()]:
        if l[0] not in "#|": return l
    return ""
def post(svc,route,payload):
    return json.loads(urllib.request.urlopen(urllib.request.Request(svc+route,data=json.dumps(payload).encode(),headers={"Content-Type":"application/json"}),timeout=120).read())

# 1. rich records (mirror dedup-embed)
recs={}
for sub,typ in (("wiki/entities","entity"),("wiki/concepts","concept")):
    for f in glob.glob(os.path.join(PROJ,sub,"**","*.md"),recursive=True):
        fm,body=parse(f); pr=prose(body)
        if len(pr)<200 or re.search(r"\(\s*content pending\s*\)",pr,re.I): continue
        slug=os.path.basename(f)[:-3]; title=fm.get("title") or slug
        tags=fm.get("tags") if isinstance(fm.get("tags"),list) else []
        embed_text=f"{typ}: {title}"+(f" [{', '.join(tags)}]" if tags else "")+f" — {pr[:1200]}"
        if sha(embed_text) not in cache: continue
        pid=os.path.relpath(f,PROJ)
        desc=(fm.get("description") or firstpara(body))[:200]
        recs[pid]={"pid":pid,"slug":slug,"type":typ,"title":title,"tags":tags,"desc":desc,"embed":embed_text}
recs=list(recs.values())
print(f"rich pages: {len(recs)}")

# 2. upsert + candidate pairs via live service
DB=tempfile.mkdtemp(prefix="e2e_")
post(SVC,"/clear",{"db_path":DB})
post(SVC,"/upsert",{"db_path":DB,"items":[{"id":r["pid"],"vector":cache[sha(r["embed"])],"type":r["type"],"title":r["title"]} for r in recs]})
pairs=post(SVC,"/candidate_pairs",{"db_path":DB,"threshold":0.15,"k":6})["pairs"]
print(f"candidate pairs: {len(pairs)}")

# 3. union-find clusters
parent={}
def find(x):
    parent.setdefault(x,x)
    while parent[x]!=x: parent[x]=parent[parent[x]]; x=parent[x]
    return x
for p in pairs:
    ra,rb=find(p["a"]),find(p["b"])
    if ra!=rb: parent[ra]=rb
clusters={}
for n in parent: clusters.setdefault(find(n),[]).append(n)
clusters=[c for c in clusters.values() if len(c)>=2]
print(f"clusters: {len(clusters)}  (sizes: {sorted((len(c) for c in clusters),reverse=True)[:10]})")

# 4. pack into batches (<=120 pages)
batches=[]; cur=[]
for c in clusters:
    if cur and len(cur)+len(c)>120: batches.append(cur); cur=[]
    cur+=c
if cur: batches.append(cur)
print(f"detector batches: {len(batches)}")

byid={r["pid"]:r for r in recs}
def confirm(paths):
    summaries=[byid[p] for p in paths if p in byid]
    lines=[]
    for s in summaries:
        tg=f" [{', '.join(s['tags'])}]" if s['tags'] else ""
        dp=f" — {s['desc']}" if s['desc'] else ""
        lines.append(f'- type={s["type"]}, slug={s["slug"]}, title={json.dumps(s["title"])}{tg}{dp}')
    user=f"## Wiki pages to scan ({len(summaries)} entries)\n\n"+"\n".join(lines)+"\n\nReturn duplicate groups as JSON only."
    body={"model":MODEL,"stream":False,"temperature":0.1,"max_tokens":4096,"chat_template_kwargs":{"enable_thinking":False},
          "messages":[{"role":"system","content":SYS},{"role":"user","content":user}]}
    r=json.loads(urllib.request.urlopen(urllib.request.Request(LLM,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"}),timeout=300).read())
    txt=r["choices"][0]["message"]["content"]
    m=re.search(r"\{.*\}",txt,re.S)
    try: return json.loads(m.group(0))["groups"] if m else []
    except Exception: return []

t0=time.time(); groups=[]
for i,b in enumerate(batches):
    g=confirm(b); groups+=g
    print(f"  batch {i+1}/{len(batches)} ({len(b)} pages) -> {len(g)} groups [{time.time()-t0:.1f}s]")
print(f"\n=== CONFIRMED DUPLICATE GROUPS: {len(groups)} (total pipeline {time.time()-t0:.1f}s + embed/candidate) ===")
for g in sorted(groups,key=lambda x:-len(x.get("slugs",[])))[:20]:
    print(f"  [{g.get('confidence','?'):6}] {g.get('slugs')}  — {g.get('reason','')[:80]}")
