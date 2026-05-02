"""
Hello PocketFlow — minimal three-node flow with conditional branching.

Demonstrates the lifecycle (prep -> exec -> post), shared-state mutation
in `post` only, and the `>>` / `- "action" >>` composition syntax.

Modelled on the verify+repair-selectors workflow shape so reading this
prepares you for Phase 3 of plans/pocketflow-integration.md.

Run:
    node packages/bridge/scripts/run-flow.mjs examples/flows/hello.py
"""
import json
import sys

from pocketflow import Flow, Node


class Validate(Node):
    """Read input from shared and decide which branch to take."""

    def prep(self, shared):
        return shared.get("name", "")

    def exec(self, name):
        # exec is pure: input -> output, no side effects
        is_valid = isinstance(name, str) and len(name.strip()) > 0
        return {"is_valid": is_valid, "name": name}

    def post(self, shared, prep_res, exec_res):
        # post is where shared mutation happens
        shared["validated_at"] = "2026-04-29"
        shared["is_valid"] = exec_res["is_valid"]
        return "valid" if exec_res["is_valid"] else "invalid"


class Greet(Node):
    """Happy path."""

    def prep(self, shared):
        return shared["name"]

    def exec(self, name):
        return f"Hello, {name}! Welcome to PocketFlow."

    def post(self, shared, prep_res, exec_res):
        shared["greeting"] = exec_res
        return "default"


class Reject(Node):
    """Sad path."""

    def post(self, shared, prep_res, exec_res):
        shared["error"] = "name is required and must be a non-empty string"
        return "default"


def build_flow():
    """Build and return the flow. Separate function so tests/runners can introspect."""
    validate = Validate()
    greet = Greet()
    reject = Reject()

    validate - "valid" >> greet
    validate - "invalid" >> reject

    return Flow(start=validate)


if __name__ == "__main__":
    # Read shared-state JSON from stdin if piped; otherwise default.
    shared = {}
    if not sys.stdin.isatty():
        try:
            shared = json.loads(sys.stdin.read())
        except json.JSONDecodeError:
            shared = {}
    if not shared:
        shared = {"name": "world"}

    flow = build_flow()
    flow.run(shared)

    json.dump(shared, sys.stdout, indent=2)
    sys.stdout.write("\n")
