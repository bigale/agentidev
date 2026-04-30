"""
agentidev_llm — drop-in `call_llm` for PocketFlow cookbook examples.

Replaces the OpenAI-keyed `call_llm` in cookbook/*/utils.py with one that
hits the bridge's local /llm endpoint. The bridge picks the actual provider
(Claude Code CLI, Ollama, WebLLM, direct API) — flows don't care.

Usage in a flow:

    from agentidev_llm import call_llm

    response = call_llm("Summarize the following:\\n" + text)

Env vars:
    AGENTIDEV_BRIDGE_URL — defaults to http://localhost:9876
    AGENTIDEV_LLM_MODEL  — 'opus' | 'sonnet' | 'haiku' (default sonnet)
    AGENTIDEV_LLM_TIMEOUT_MS — int (default 120000)

No external deps — uses urllib only.
"""
import json
import os
import urllib.error
import urllib.request


_DEFAULT_BRIDGE = "http://localhost:9876"


def call_llm(
    prompt: str,
    *,
    system: str | None = None,
    model: str | None = None,
    schema: dict | None = None,
    timeout_ms: int | None = None,
    bridge_url: str | None = None,
) -> str | dict:
    """Send a prompt to the bridge's /llm endpoint and return the result.

    With no schema, returns the raw response text.
    With a schema (dict in JSON Schema format), returns the parsed JSON object.
    Raises RuntimeError on bridge or LLM error.
    """
    base = bridge_url or os.environ.get("AGENTIDEV_BRIDGE_URL") or _DEFAULT_BRIDGE
    body = {"prompt": prompt}
    if system is not None:
        body["system"] = system
    if model is not None:
        body["model"] = model
    elif os.environ.get("AGENTIDEV_LLM_MODEL"):
        body["model"] = os.environ["AGENTIDEV_LLM_MODEL"]
    if schema is not None:
        body["schema"] = schema
    if timeout_ms is not None:
        body["timeout"] = timeout_ms
    elif os.environ.get("AGENTIDEV_LLM_TIMEOUT_MS"):
        body["timeout"] = int(os.environ["AGENTIDEV_LLM_TIMEOUT_MS"])

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/llm",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # urllib timeout is in seconds; allow ~5s of slack on top of the bridge
    # timeout so the HTTP call doesn't kill a request the bridge is still
    # processing.
    sock_timeout = ((body.get("timeout") or 120000) / 1000.0) + 5.0
    try:
        with urllib.request.urlopen(req, timeout=sock_timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")
            err_obj = json.loads(err_body)
            raise RuntimeError(f"bridge /llm {e.code}: {err_obj.get('error', err_body)}") from None
        except (ValueError, AttributeError):
            raise RuntimeError(f"bridge /llm {e.code}: {e.reason}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"bridge /llm unreachable: {e.reason}") from None

    if not payload.get("success"):
        raise RuntimeError(f"LLM call failed: {payload.get('error', 'unknown')}")
    return payload["result"]


if __name__ == "__main__":
    # Quick smoke test:  python3 agentidev_llm.py "Say hello in one word"
    import sys
    p = " ".join(sys.argv[1:]) or "Reply with the single word: ok"
    print(call_llm(p))
