"""care-evals adapters — invoke a skill headless and return raw output + metadata.

An adapter's only job: run one model with one prompt in one cwd, and hand back the
model's text plus what it cost. Prompt assembly and staging live in run_eval.py; grading
lives in grader.py. Adapters are intentionally thin (the plan's "thin subprocess adapter").

Three adapters:
  - mock:     no model. Replays tasks/<id>/mock_response.md (offline plumbing / CI of the harness).
  - sdk:      Claude via the `claude` CLI in headless print mode (judgment tiers).
  - opencode: `opencode run` (free-model ladder rungs).

stdlib only.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field

# Per-model-call wall-clock cap. A hung generation (e.g. an orchestrator skill looping on subagent
# attempts on a weak free model) becomes a clean invalid JobResult, not an infinite block that stalls
# a whole ladder sweep. Override with $CARE_EVALS_TIMEOUT (seconds).
CALL_TIMEOUT = int(os.environ.get("CARE_EVALS_TIMEOUT", "300"))


@dataclass
class InvokeResult:
    text: str
    model_used: str
    adapter: str
    cost_usd: float = 0.0
    raw: dict = field(default_factory=dict)


class AdapterError(RuntimeError):
    """Raised when an adapter cannot run (missing binary, missing mock, model error)."""


def _resolve_binary(name: str, env_vars: tuple[str, ...] = (), fallbacks: tuple[str, ...] = ()) -> str | None:
    """PATH-independent binary resolution: $ENV override → PATH → known install fallback.
    Needed because a sandboxed shell may not inherit the user's profile PATH (e.g. opencode lives
    in ~/.opencode/bin, wired only in the interactive shell's rc)."""
    for ev in env_vars:
        v = os.environ.get(ev)
        if v and os.path.isfile(os.path.expanduser(v)):
            return os.path.expanduser(v)
    found = shutil.which(name)
    if found:
        return found
    for fb in fallbacks:
        p = os.path.expanduser(fb)
        if os.path.isfile(p):
            return p
    return None


class Adapter:
    name = "base"

    def invoke(self, *, prompt: str, cwd: str, model: str | None, mock_path: str | None = None) -> InvokeResult:
        raise NotImplementedError


class MockAdapter(Adapter):
    """Replays a canned skill response so the staging → collect → grade → aggregate
    pipeline can be exercised end-to-end with no model access."""

    name = "mock"

    def invoke(self, *, prompt: str, cwd: str, model: str | None, mock_path: str | None = None) -> InvokeResult:
        if not mock_path or not os.path.isfile(mock_path):
            raise AdapterError(
                f"mock adapter needs a canned response file; expected at {mock_path!r}. "
                "Add tasks/<id>/mock_response.md or run with --adapter sdk|opencode."
            )
        with open(mock_path, encoding="utf-8") as fh:
            text = fh.read()
        return InvokeResult(text=text, model_used=model or "mock", adapter=self.name, cost_usd=0.0)


class SdkAdapter(Adapter):
    """Claude via the `claude` CLI headless print mode. `model` is passed through as the
    pin (e.g. claude-opus-4-8 / a Haiku|Sonnet id for the ladder)."""

    name = "sdk"

    def invoke(self, *, prompt: str, cwd: str, model: str | None, mock_path: str | None = None) -> InvokeResult:
        binary = shutil.which("claude")
        if not binary:
            raise AdapterError(
                "`claude` CLI not on PATH. Install the Claude CLI/Agent SDK, or use --adapter mock."
            )
        cmd = [binary, "-p", prompt, "--output-format", "json"]
        if model:
            cmd += ["--model", model]
        try:
            proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=CALL_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise AdapterError(f"claude timed out after {CALL_TIMEOUT}s")
        if proc.returncode != 0:
            raise AdapterError(f"claude exited {proc.returncode}: {proc.stderr.strip()[:500]}")
        return _parse_claude_json(proc.stdout, requested_model=model)


class OpenCodeServeAdapter(Adapter):
    """RELIABLE free-model transport (default `opencode`). Talks to a warm `opencode serve` over its
    HTTP API via the SYNCHRONOUS `POST /session/{id}/message` ("send and wait") endpoint — one fresh
    session per call, tools disabled (our inlined-skill eval needs none), model pinned by
    provider/modelID. This avoids every failure mode of the CLI path (`opencode-run`): no per-call
    server cold-start, no shared-server wedge, and a tool-less generation can't hang spawning
    subagents (the care-review wedge). Server URL from $OPENCODE_SERVER_URL (default 127.0.0.1:4599);
    the runner starts the server once around a sweep."""

    name = "opencode"
    _DISABLED_TOOLS = {t: False for t in (
        "bash", "edit", "write", "read", "grep", "glob", "list", "patch", "webfetch",
        "task", "agent", "todowrite", "todoread", "invalid")}

    def invoke(self, *, prompt: str, cwd: str, model: str | None, mock_path: str | None = None) -> InvokeResult:
        import urllib.request, urllib.error
        base = os.environ.get("OPENCODE_SERVER_URL", "http://127.0.0.1:4599").rstrip("/")
        if not model or "/" not in model:
            raise AdapterError(f"opencode model must be provider/modelID, got {model!r}")
        provider, model_id = model.split("/", 1)

        def _req(method, path, body=None):
            data = json.dumps(body).encode() if body is not None else None
            r = urllib.request.Request(base + path, data=data, method=method,
                                       headers={"content-type": "application/json"})
            try:
                with urllib.request.urlopen(r, timeout=CALL_TIMEOUT) as resp:
                    return json.loads(resp.read() or "null")
            except urllib.error.URLError as e:
                raise AdapterError(f"opencode serve unreachable at {base} ({e}); start `opencode serve --port 4599`")

        try:
            s = _req("POST", "/session", {})
            sid = (s.get("data") or s)["id"]
        except (KeyError, TypeError) as e:
            raise AdapterError(f"session create failed: {e}")
        try:
            try:
                resp = _req("POST", f"/session/{sid}/message", {
                    "model": {"providerID": provider, "modelID": model_id},
                    "tools": self._DISABLED_TOOLS,
                    "parts": [{"type": "text", "text": prompt}],
                })
            except urllib.error.HTTPError as e:  # never reached (URLopen wraps), kept for clarity
                raise AdapterError(f"opencode message failed: {e}")
            info = resp.get("data", resp) if isinstance(resp, dict) else {}
            text = "".join(p.get("text", "") for p in (info.get("parts") or []) if p.get("type") == "text").strip()
            meta = info.get("info", {}) if isinstance(info, dict) else {}
            cost = float(meta.get("cost") or 0.0)
            return InvokeResult(text=text, model_used=model, adapter=self.name, cost_usd=cost,
                                raw={"tokens": meta.get("tokens", {})})
        finally:
            try:
                _req("DELETE", f"/session/{sid}")
            except Exception:
                pass


class OpenCodeAdapter(Adapter):
    """LEGACY free-model transport via `opencode run` (name `opencode-run`). Kept for one-off use;
    NOT reliable for batch sweeps — each call cold-starts/attaches a shared server that wedges under
    load, and orchestrator skills (care-review) can hang it. Prefer the `opencode` serve adapter.
    Uses `--format json` (default format emits ANSI + a header) and `--auto` for permissions."""

    name = "opencode-run"

    def invoke(self, *, prompt: str, cwd: str, model: str | None, mock_path: str | None = None) -> InvokeResult:
        binary = _resolve_binary("opencode", ("OPENCODE_BIN",), ("~/.opencode/bin/opencode",))
        if not binary:
            raise AdapterError(
                "`opencode` not found (PATH, $OPENCODE_BIN, or ~/.opencode/bin). "
                "Install OpenCode, or use --adapter mock|sdk."
            )
        cmd = [binary, "run", "--auto", "--format", "json"]
        if model:
            cmd += ["--model", model]
        cmd.append(prompt)
        try:
            proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=CALL_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise AdapterError(f"opencode timed out after {CALL_TIMEOUT}s (model {model})")
        if proc.returncode != 0:
            raise AdapterError(f"opencode exited {proc.returncode}: {proc.stderr.strip()[:500]}")
        return _parse_opencode_json(proc.stdout, model)


def _parse_claude_json(stdout: str, requested_model: str | None) -> InvokeResult:
    """The claude CLI `--output-format json` returns a result envelope. Be defensive:
    fall back to raw stdout if the shape is unexpected."""
    text = stdout.strip()
    model_used = requested_model or "unknown"
    cost = 0.0
    raw: dict = {}
    try:
        raw = json.loads(stdout)
        text = raw.get("result") or raw.get("text") or text
        model_used = raw.get("model") or model_used
        cost = float(raw.get("total_cost_usd") or raw.get("cost_usd") or 0.0)
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return InvokeResult(text=text, model_used=model_used, adapter="sdk", cost_usd=cost, raw=raw)


def _openrouter_key() -> str | None:
    """Key resolution that keeps the secret out of the chat transcript: env → key file
    ($OPENROUTER_KEY_FILE / ~/.openrouter_key) → the repo `.env` (OPENROUTER_API_KEY=...)."""
    k = os.environ.get("OPENROUTER_API_KEY")
    if k:
        return k.strip()
    for path in (os.environ.get("OPENROUTER_KEY_FILE"), "~/.openrouter_key"):
        if path and os.path.isfile(os.path.expanduser(path)):
            with open(os.path.expanduser(path)) as fh:
                return fh.read().strip()
    here = os.path.dirname(os.path.abspath(__file__))          # care-evals/runner
    env_path = os.path.abspath(os.path.join(here, "..", "..", ".env"))  # <skills-repo>/.env
    if os.path.isfile(env_path):
        for line in open(env_path):
            if line.strip().startswith("OPENROUTER_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


class OpenRouterAdapter(Adapter):
    """Reliable stateless transport for any OpenRouter model via the OpenAI SDK (OpenRouter is
    OpenAI-compatible — point base_url at it). One HTTPS call per task; the SDK handles TLS + retries.
    Model = OpenRouter slug, e.g. `anthropic/claude-haiku-4.5`. Key from env / ~/.openrouter_key / .env."""

    name = "openrouter"

    def invoke(self, *, prompt: str, cwd: str, model: str | None, mock_path: str | None = None) -> InvokeResult:
        key = _openrouter_key()
        if not key:
            raise AdapterError("no OpenRouter key: set $OPENROUTER_API_KEY, write ~/.openrouter_key, or add it to the repo .env")
        if not model:
            raise AdapterError("openrouter adapter needs --model <slug> (e.g. anthropic/claude-haiku-4.5)")
        try:
            from openai import OpenAI
        except ImportError:
            raise AdapterError("openai SDK not installed (pip install openai)")
        client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=key)
        max_tokens = int(os.environ.get("CARE_EVALS_MAX_TOKENS", "4096"))
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=max_tokens,
                timeout=CALL_TIMEOUT,
                extra_body={"usage": {"include": True}},  # OpenRouter cost accounting
            )
        except Exception as e:
            raise AdapterError(f"openrouter call failed: {type(e).__name__}: {str(e)[:300]}")
        choice = resp.choices[0] if resp.choices else None
        text = ((choice.message.content if choice and choice.message else "") or "").strip()
        cost = 0.0
        u = getattr(resp, "usage", None)
        if u is not None:
            cost = float(getattr(u, "cost", None) or (getattr(u, "model_extra", {}) or {}).get("cost") or 0.0)
        return InvokeResult(text=text, model_used=getattr(resp, "model", model) or model,
                            adapter=self.name, cost_usd=cost, raw={})


def _parse_opencode_json(stdout: str, requested_model: str | None) -> InvokeResult:
    """`opencode run --format json` emits one JSON event per line. Concatenate `type:"text"`
    parts for the answer; read cost + token totals from `step_finish`. Defensive: skip unparseable
    lines, fall back to raw stdout if no text events were seen."""
    texts: list[str] = []
    cost = 0.0
    tokens: dict = {}
    saw_event = False
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        saw_event = True
        part = ev.get("part") or {}
        if ev.get("type") == "text":
            t = part.get("text")
            if t:
                texts.append(t)
        elif ev.get("type") == "step_finish":
            cost += float(part.get("cost") or 0.0)
            tk = part.get("tokens")
            if isinstance(tk, dict):
                tokens = tk
    text = "".join(texts).strip()
    if not text and not saw_event:
        text = stdout.strip()  # not JSON after all — hand back raw
    return InvokeResult(text=text, model_used=requested_model or "opencode-default",
                        adapter="opencode", cost_usd=cost, raw={"tokens": tokens})


_ADAPTERS = {a.name: a for a in (MockAdapter(), SdkAdapter(), OpenCodeServeAdapter(), OpenCodeAdapter(), OpenRouterAdapter())}


def get_adapter(name: str) -> Adapter:
    try:
        return _ADAPTERS[name]
    except KeyError:
        raise AdapterError(f"unknown adapter {name!r}; choose from {sorted(_ADAPTERS)}")
