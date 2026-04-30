"""
hello-llm — minimal proof that flows can call the LLM via the bridge shim.

Validate -> Ask -> Polish three-node flow. The Ask node calls the LLM via
agentidev_llm.call_llm, which posts to the bridge's /llm endpoint. No
OpenAI key, no provider config in the flow — the bridge picks the
provider.

Run:
    node packages/bridge/scripts/run-flow.mjs examples/flows/hello-llm.py
    echo '{"topic": "the agentidev stack"}' | node packages/bridge/scripts/run-flow.mjs examples/flows/hello-llm.py
"""
import json
import sys

from agentidev_llm import call_llm
from pocketflow import Flow, Node


class Validate(Node):
    def prep(self, shared):
        return shared.get("topic", "")

    def exec(self, topic):
        return {"valid": isinstance(topic, str) and len(topic.strip()) > 0, "topic": topic}

    def post(self, shared, prep_res, exec_res):
        if not exec_res["valid"]:
            shared["error"] = "topic is required"
            return "invalid"
        return "valid"


class Ask(Node):
    def __init__(self):
        super().__init__(max_retries=2, wait=1)

    def prep(self, shared):
        return shared["topic"]

    def exec(self, topic):
        return call_llm(
            f"Write a single haiku (3 lines, 5-7-5 syllables) about: {topic}. "
            "Output the haiku only, no commentary."
        )

    def post(self, shared, prep_res, exec_res):
        shared["haiku"] = exec_res.strip()
        return "default"


class Polish(Node):
    def post(self, shared, prep_res, exec_res):
        # Could call_llm again to refine; for the smoke test we just record done
        shared["done_at"] = "2026-04-29"
        return "default"


def build_flow():
    validate, ask, polish = Validate(), Ask(), Polish()
    validate - "valid" >> ask >> polish
    return Flow(start=validate)


if __name__ == "__main__":
    # If stdin was piped and parses, use it (even if topic is empty — that's
    # a deliberate test of the Reject branch). Default only when no stdin
    # was piped at all.
    shared = None
    if not sys.stdin.isatty():
        raw = sys.stdin.read()
        if raw.strip():
            try: shared = json.loads(raw)
            except json.JSONDecodeError: shared = {}
    if shared is None:
        shared = {"topic": "small things that compose well"}

    flow = build_flow()
    flow.run(shared)

    json.dump(shared, sys.stdout, indent=2)
    sys.stdout.write("\n")
