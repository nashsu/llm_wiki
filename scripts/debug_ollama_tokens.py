#!/usr/bin/env python3
"""
debug_ollama_tokens.py — reproduce LLM Wiki's wiki-generation request against a
raw Ollama endpoint so we can see exactly why generation reports "too many
tokens".

Why this exists
---------------
The app's Step-2 "Generate wiki pages" call (src/lib/ingest.ts) sends, to the
OpenAI-compatible /v1/chat/completions endpoint:

    { model, stream:true, temperature:0.1, reasoning_effort:"none",
      max_tokens: computeIngestGenerationMaxTokens(maxContextSize),
      messages:[ {system: big generation prompt}, {user: analysis + source} ] }

`maxContextSize` is measured in CHARACTERS (default 204_800). The crucial
mismatch: the OpenAI-compat endpoint has NO num_ctx control, so Ollama serves
with whatever num_ctx the model was loaded at (default, NOT the model's full
262k). When prompt_tokens + max_tokens overflow that window, Ollama complains.

This script lets you:
  * see the model's loaded context window (/api/show, /api/ps),
  * fire the exact app-shaped request at a chosen prompt size + max_tokens,
  * sweep prompt sizes to find the failure threshold,
  * compare the OpenAI-compat path (no num_ctx) against the native /api/chat
    path WITH options.num_ctx, to confirm num_ctx is the real lever.

Pure stdlib — no pip install. Run:  python3 scripts/debug_ollama_tokens.py --help
"""

from __future__ import annotations
import argparse, json, sys, time, urllib.request, urllib.error

# ── The app's actual generation max_tokens ladder (src/lib/ingest.ts:45-48,
#    1687-1693). maxContextSize is in CHARACTERS. ────────────────────────────
def app_generation_max_tokens(max_context_chars: int) -> int:
    if max_context_chars >= 512_000: return 32_768
    if max_context_chars >= 256_000: return 24_576
    if max_context_chars >= 128_000: return 16_384
    return 8_192


def http_json(url: str, payload: dict, timeout: float) -> tuple[int, dict | str]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:  # noqa: BLE001 — we want every failure mode visible
        return -1, f"{type(e).__name__}: {e}"


def make_prompt(chars: int) -> str:
    """Filler roughly `chars` long (~5 chars/token, so tokens ≈ chars/5)."""
    return "word " * max(1, chars // 5)


def show_model(base: str, model: str, timeout: float) -> None:
    code, body = http_json(f"{base}/api/show", {"model": model}, timeout)
    print(f"── /api/show ({model}) ──")
    if isinstance(body, dict):
        print("  parameters (Modelfile defaults):")
        for line in str(body.get("parameters", "(none)")).splitlines():
            print(f"    {line}")
        mi = body.get("model_info", {})
        ctx = next((v for k, v in mi.items() if k.endswith("context_length")), "?")
        print(f"  model max context_length: {ctx}")
    else:
        print(f"  HTTP {code}: {body}")
    code, ps = http_json(f"{base}/api/ps", {}, timeout)
    if isinstance(ps, dict):
        for m in ps.get("models", []):
            if m.get("name", "").startswith(model.split(":")[0]):
                print(f"  LOADED num_ctx (context_length in /api/ps): {m.get('context_length','?')}")
    print()


def call_openai(base: str, model: str, prompt: str, max_tokens: int, timeout: float) -> dict:
    """Exactly what the app sends (OpenAI-compat, no num_ctx possible)."""
    payload = {
        "model": model, "stream": False, "temperature": 0.1,
        "reasoning_effort": "none", "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": "You generate wiki FILE blocks. Reply briefly."},
            {"role": "user", "content": prompt},
        ],
    }
    t0 = time.time()
    code, body = http_json(f"{base}/v1/chat/completions", payload, timeout)
    dt = time.time() - t0
    out = {"path": "openai", "http": code, "secs": round(dt, 1), "max_tokens": max_tokens}
    if isinstance(body, dict):
        u = body.get("usage", {})
        out.update(prompt_tokens=u.get("prompt_tokens"), completion_tokens=u.get("completion_tokens"),
                   finish=body.get("choices", [{}])[0].get("finish_reason"))
    else:
        out["error"] = str(body)[:500]
    return out


def call_native(base: str, model: str, prompt: str, max_tokens: int, num_ctx: int | None, timeout: float) -> dict:
    """Native /api/chat — lets us set options.num_ctx, which /v1 cannot."""
    options = {"temperature": 0.1, "num_predict": max_tokens}
    if num_ctx is not None:
        options["num_ctx"] = num_ctx
    payload = {
        "model": model, "stream": False, "think": False, "options": options,
        "messages": [
            {"role": "system", "content": "You generate wiki FILE blocks. Reply briefly."},
            {"role": "user", "content": prompt},
        ],
    }
    t0 = time.time()
    code, body = http_json(f"{base}/api/chat", payload, timeout)
    dt = time.time() - t0
    out = {"path": "native", "http": code, "secs": round(dt, 1), "max_tokens": max_tokens, "num_ctx": num_ctx}
    if isinstance(body, dict):
        out.update(prompt_eval_count=body.get("prompt_eval_count"), eval_count=body.get("eval_count"),
                   done_reason=body.get("done_reason"), error=body.get("error"))
    else:
        out["error"] = str(body)[:500]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Debug Ollama 'too many tokens' for LLM Wiki generation.")
    ap.add_argument("--base", default="http://localhost:11434", help="Ollama base URL")
    ap.add_argument("--model", default="gemma4:12b")
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--prompt-chars", type=int, default=60_000,
                    help="approx prompt size in characters (tokens ~= chars/5)")
    ap.add_argument("--prompt-file", help="use this file's contents as the user prompt instead of filler")
    ap.add_argument("--max-tokens", type=int, default=None,
                    help="override; default = app's ladder for --max-context-chars")
    ap.add_argument("--max-context-chars", type=int, default=204_800,
                    help="the app's maxContextSize (chars); picks max_tokens via the app ladder")
    ap.add_argument("--num-ctx", type=int, default=None,
                    help="native path only: num_ctx to allocate (the lever /v1 lacks)")
    ap.add_argument("--native", action="store_true", help="use native /api/chat instead of /v1")
    ap.add_argument("--sweep", action="store_true",
                    help="sweep prompt sizes (2k,20k,60k,120k,200k chars) at the app's max_tokens")
    args = ap.parse_args()

    max_tokens = args.max_tokens if args.max_tokens is not None else app_generation_max_tokens(args.max_context_chars)
    print(f"App ladder: maxContextSize={args.max_context_chars} chars -> max_tokens={max_tokens}\n")

    show_model(args.base, args.model, args.timeout)

    prompt = open(args.prompt_file, encoding="utf-8").read() if args.prompt_file else None

    if args.sweep:
        print("── sweep (each row is one generation; watch where http!=200 / error appears) ──")
        for pc in [2_000, 20_000, 60_000, 120_000, 200_000]:
            p = prompt or make_prompt(pc)
            r = (call_native(args.base, args.model, p, max_tokens, args.num_ctx, args.timeout)
                 if args.native else call_openai(args.base, args.model, p, max_tokens, args.timeout))
            print(f"  prompt~{pc:>7}c  {json.dumps(r)}")
        return 0

    p = prompt or make_prompt(args.prompt_chars)
    r = (call_native(args.base, args.model, p, max_tokens, args.num_ctx, args.timeout)
         if args.native else call_openai(args.base, args.model, p, max_tokens, args.timeout))
    print("── single request ──")
    print(json.dumps(r, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
