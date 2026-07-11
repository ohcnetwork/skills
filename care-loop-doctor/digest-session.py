#!/usr/bin/env python3
"""digest-session.py — compact factual digest of Copilot session evidence (care-loop-doctor).

Auto-detects and digests BOTH evidence formats:

  Tier B — manual UI export `agent-debug-log-<session>.json` (OTLP-style spans): per-turn models
           + token counts, subagent spawns + model args, tool errors, mid-turn-death detection.
  Tier A — VS Code chat-session storage `chatSessions/*.jsonl` (auto-discoverable via
           find-sessions.sh): either a plain session snapshot (version 3, requests[]) or a patch
           log ({kind:0,v:snapshot} then {kind:1|2,k:path,v:val}). Patch semantics are NOT
           replayed — request-like objects (anything carrying modelId) are harvested recursively
           and deduped, which is enough for per-request model/agent/timeline facts.

Hundreds of spans / patch lines reduce to ~50 lines per session so the diagnosing model starts
from judgment, not parsing (same token move as care-loop's run_gate.sh / collect-feedback.sh).
Facts only — rubric.md decides what they mean.

Usage: digest-session.py <file.json|file.jsonl> [more ...]
Exit: 0 digests printed · 2 a file was unreadable (named on stderr; others still digested).

The sibling `copilot_all_prompts_*.json` export is a third schema — read it selectively by hand
(grep for model / system-prompt lines) per SKILL.md; no parser here.
"""
import json
import sys
from datetime import datetime


# ---------- shared ----------

def attr_map(entity):
    out = {}
    for a in entity.get("attributes", []) or []:
        vals = a.get("value", {}) or {}
        out[a.get("key", "")] = next(iter(vals.values()), "")
    return out


def fmt_ns(nanos):
    try:
        return datetime.fromtimestamp(int(nanos) / 1e9).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "?"


def fmt_ms(millis):
    try:
        return datetime.fromtimestamp(int(millis) / 1e3).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "?"


def head(s, n=80):
    return str(s)[:n].replace("\n", " ")


# ---------- Tier B: agent-debug-log span export ----------

def digest_spans(path, data):
    spans = []
    session_id = "?"
    for rs in data.get("resourceSpans", []) or []:
        res_attrs = attr_map(rs.get("resource", {}) or {})
        session_id = res_attrs.get("session.id", session_id)
        for ss in rs.get("scopeSpans", []) or []:
            spans.extend(ss.get("spans", []) or [])
    if not spans:
        print(f"digest[spans]: {path}: no spans found")
        return

    first_ts = min(int(s.get("startTimeUnixNano", 0) or 0) for s in spans)
    last_ts = max(int(s.get("endTimeUnixNano", 0) or 0) for s in spans)
    dur_min = (last_ts - first_ts) / 1e9 / 60 if last_ts > first_ts else 0

    user_msgs = 0
    turns = 0
    models = {}          # model -> {calls, out_sum, first_in, last_in}
    chat_seq = []        # (msg_idx, turn_label, model, in_tok, out_tok)
    spawns = []          # (msg_idx, turn_label, agent, model_arg, prompt_head)
    errors = {}          # summary line -> count
    cur_turn = "-"

    for s in spans:
        name = s.get("name", "")
        attrs = attr_map(s)

        if name == "user_message":
            user_msgs += 1
            cur_turn = "-"
        elif name.startswith("turn_start"):
            turns += 1
            cur_turn = name.split(":", 1)[-1]

        model = attrs.get("gen_ai.request.model", "")
        if name.startswith("chat:") and model:
            in_t = int(attrs.get("gen_ai.usage.input_tokens", 0) or 0)
            out_t = int(attrs.get("gen_ai.usage.output_tokens", 0) or 0)
            m = models.setdefault(model, {"calls": 0, "out": 0, "first_in": in_t, "last_in": in_t})
            m["calls"] += 1
            m["out"] += out_t
            m["last_in"] = in_t
            chat_seq.append((user_msgs, cur_turn, model, in_t, out_t))

        tool = attrs.get("gen_ai.tool.name", "")
        if tool and ("subagent" in tool.lower() or tool in ("Task", "Agent")):
            raw = attrs.get("gen_ai.tool.call.arguments", "")
            agent, marg, phead = "", "", ""
            try:
                args = json.loads(raw)
                agent = str(args.get("subagent_type") or args.get("agent") or args.get("name") or "")
                marg = str(args.get("model") or "")
                phead = head(args.get("prompt") or "", 90)
            except Exception:
                phead = head(raw, 90)
            spawns.append((user_msgs, cur_turn, agent or "(generic)", marg or "(no model arg)", phead))

        if s.get("status", {}).get("code", 0) != 0:
            result = head(attrs.get("gen_ai.tool.call.result", ""), 110)
            key = f"{tool or name} → {result or '(no result)'}"
            errors[key] = errors.get(key, 0) + 1

    # how the session ended: does the last turn_start have a turn_end after it?
    last_start_i = max((i for i, s in enumerate(spans) if s.get("name", "").startswith("turn_start")), default=-1)
    ended_clean = True
    if last_start_i >= 0:
        tail = [sp.get("name", "") for sp in spans[last_start_i:]]
        ended_clean = any(n.startswith("turn_end") for n in tail)

    # biggest input-token jumps between consecutive chat calls (cache-miss / big-paste suspects)
    jumps = []
    for i in range(1, len(chat_seq)):
        d = chat_seq[i][3] - chat_seq[i - 1][3]
        if d > 0:
            jumps.append((d, chat_seq[i]))
    jumps.sort(key=lambda j: -j[0])

    print(f"digest[spans]: {path}")
    print(f"  session:  {session_id}")
    print(f"  window:   {fmt_ns(first_ts)} → {fmt_ns(last_ts)}  ({dur_min:.1f} min) · {len(spans)} spans · {user_msgs} user message(s), {turns} turn(s)")
    print("  models:")
    for m, st in models.items():
        print(f"    {m}: {st['calls']} call(s) · input {st['first_in']}→{st['last_in']} · output total {st['out']}")
    print(f"  spawns:   {len(spawns)}")
    for msg, t, agent, marg, phead in spawns:
        print(f"    [msg{msg} turn{t}] agent={agent} model={marg} :: {phead}")
    print(f"  tool errors (status!=0): {sum(errors.values())}")
    for line, n in list(errors.items())[:8]:
        print(f"    ×{n} {line}")
    print(f"  ending:   {'clean (last turn closed)' if ended_clean else 'DIED MID-TURN — last turn_start has no turn_end after it'}")
    if jumps:
        print("  top input-token jumps (cache-miss / paste suspects):")
        for d, (msg, t, model, in_t, _) in jumps[:3]:
            print(f"    +{d} tokens at [msg{msg} turn{t}] ({model}, input {in_t})")
    print()


# ---------- Tier A: VS Code chatSessions storage ----------

def harvest_chat(records, path, session_hint):
    """records: iterable of parsed JSON values (snapshot + patches, or one snapshot)."""
    session_id = session_hint
    creation = None
    title = None
    entries = {}     # dedupe key -> (ts, modelId, agent, msg_head)
    tools = 0
    tool_heads = {}

    def walk(o):
        nonlocal tools, session_id, creation, title
        if isinstance(o, dict):
            if isinstance(o.get("sessionId"), str):
                session_id = o["sessionId"]
            if creation is None and "creationDate" in o:
                creation = o.get("creationDate")
            if o.get("customTitle"):
                title = o["customTitle"]
            if "modelId" in o:
                ts = o.get("timestamp")
                model = str(o.get("modelId") or "")
                agent = o.get("agent")
                if isinstance(agent, dict):
                    ext = agent.get("extensionId")
                    agent = agent.get("id") or agent.get("name") or (ext.get("value") if isinstance(ext, dict) else "")
                msg = o.get("message")
                mhead = head(msg.get("text") or "", 60) if isinstance(msg, dict) else ""
                key = (ts, model, mhead)
                if key not in entries:
                    entries[key] = (ts, model, str(agent or ""), mhead)
            if o.get("kind") == "toolInvocationSerialized":
                tools += 1
                im = o.get("invocationMessage")
                if isinstance(im, dict):
                    im = im.get("value", "")
                h = head(im, 60)
                if h:
                    tool_heads[h] = tool_heads.get(h, 0) + 1
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    for r in records:
        walk(r)

    seq = sorted(entries.values(), key=lambda e: (e[0] is None, e[0] or 0))
    times = [e[0] for e in seq if isinstance(e[0], (int, float))]
    models = {}
    for _, m, _, _ in seq:
        models[m] = models.get(m, 0) + 1

    print(f"digest[chat]: {path}")
    print(f"  session:  {session_id}{'  ·  ' + repr(title) if title else ''}")
    win = f"{fmt_ms(creation)} → {fmt_ms(max(times))}" if creation and times else (fmt_ms(creation) if creation else "?")
    print(f"  window:   {win} · {len(seq)} request-like entr(ies) · {tools} tool invocation(s)")
    print("  models:   " + (", ".join(f"{m} ×{n}" for m, n in sorted(models.items())) or "(none found)"))
    print("  timeline (deduped; user-visible requests carry a message head):")
    for ts, m, agent, mhead in seq[:25]:
        t = fmt_ms(ts) if ts else "?"
        a = f" agent={head(agent, 40)}" if agent and agent != "None" else ""
        msg = f" :: {mhead}" if mhead else ""
        print(f"    {t}  {m}{a}{msg}")
    if len(seq) > 25:
        print(f"    … {len(seq) - 25} more")
    if tool_heads:
        top = sorted(tool_heads.items(), key=lambda kv: -kv[1])[:5]
        print("  top tool invocations: " + "; ".join(f"{h} ×{n}" for h, n in top))
    print()


# ---------- dispatch ----------

def digest_file(path):
    with open(path) as f:
        text = f.read()
    # whole-file JSON first (span export, or a plain single-JSON session snapshot)
    try:
        data = json.loads(text)
        if isinstance(data, dict) and "resourceSpans" in data:
            digest_spans(path, data)
        else:
            harvest_chat([data], path, path.rsplit("/", 1)[-1].split(".")[0])
        return
    except json.JSONDecodeError:
        pass
    # JSONL patch log: one JSON record per line
    records = []
    for l in text.splitlines():
        l = l.strip()
        if not l:
            continue
        try:
            records.append(json.loads(l))
        except Exception:
            pass
    if not records:
        raise ValueError("neither whole-file JSON nor parseable JSONL")
    harvest_chat(records, path, path.rsplit("/", 1)[-1].split(".")[0])


def main():
    if len(sys.argv) < 2:
        print("usage: digest-session.py <file.json|file.jsonl> [more ...]", file=sys.stderr)
        sys.exit(2)
    bad = 0
    for p in sys.argv[1:]:
        try:
            digest_file(p)
        except Exception as e:
            print(f"digest: {p}: unreadable ({e})", file=sys.stderr)
            bad = 2
    sys.exit(bad)


if __name__ == "__main__":
    main()
