# PocketFlow Skill

PocketFlow is a 99-line Python LLM framework. Three abstractions: `Node`, `Flow`, `BatchNode`, plus async variants. Source vendored at `packages/bridge/vendor/pocketflow/__init__.py` — read it directly when in doubt; the whole framework fits in one screen.

## Mental model

A flow is a directed graph of nodes that share a mutable `shared` dict. Each node has a three-phase lifecycle:

```python
class MyNode(Node):
    def prep(self, shared):
        # Pull inputs FROM shared. Return a value passed to exec.
        return shared["query"]

    def exec(self, prep_res):
        # Do the work. Pure function of prep_res. Retried on exception.
        return search_api(prep_res)

    def post(self, shared, prep_res, exec_res):
        # Write results back INTO shared. Return an action string
        # that selects which successor to take next.
        shared["results"] = exec_res
        return "default"  # or "found", "missing", "error"
```

**The discipline:** `exec` is pure. Side effects (mutating shared, writing files) happen in `prep` (read) or `post` (write). This is what makes retries safe — re-running `exec` doesn't double-write state.

## Composition syntax

```python
node_a >> node_b              # default transition: a --(default)--> b
node_a - "found" >> node_b    # conditional: a --(found)--> b
node_a - "missing" >> node_c  # branching: a --(missing)--> c

flow = Flow(start=node_a)
flow.run(shared={"query": "tampa dentists"})
# shared is mutated in place; flow.run returns the final action string
```

The `>>` operator is `BaseNode.__rshift__` — it calls `node_a.next(node_b)`. The `- "action" >>` form creates a `_ConditionalTransition` that records the action label.

## Choosing a node type

| Type | When |
|---|---|
| `Node(max_retries=N, wait=S)` | Standard step. Retries on exception with `wait` seconds between. |
| `BatchNode` | `exec` runs once per item in `prep_res` list. Returns list of results. |
| `AsyncNode` | I/O-bound work. Define `prep_async`, `exec_async`, `post_async`. |
| `AsyncBatchNode` | Async + batch, sequential. |
| `AsyncParallelBatchNode` | Async + batch, all `exec_async` calls in parallel via `asyncio.gather`. |
| `AsyncFlow` | Required if any node in the flow is `AsyncNode`. Sync `Node`s are still allowed inside an `AsyncFlow` — the orchestrator dispatches correctly per-node. |

**Surprise (worth knowing):** an `AsyncFlow` can mix sync and async nodes. The orchestrator checks `isinstance(curr, AsyncNode)` and uses `await` only for those.

## Retry semantics

```python
class FlakeyNode(Node):
    def __init__(self):
        super().__init__(max_retries=3, wait=2)  # try 3 times, 2s between

    def exec(self, prep_res):
        return external_call(prep_res)  # raises -> retried

    def exec_fallback(self, prep_res, exc):
        # Called after final retry fails. Default: re-raise.
        # Override to return a "graceful failure" value instead.
        return {"error": str(exc)}
```

**Rule of thumb:** for any LLM call, set `max_retries=2, wait=1`. For external HTTP, `max_retries=3, wait=2`. For local computation, default `max_retries=1` (no retry) is correct.

## Conditional branching

`post` returns an action string. The flow looks up `successors[action]` to decide what runs next. Common pattern:

```python
class ValidateNode(Node):
    def post(self, shared, prep_res, exec_res):
        if exec_res["valid"]:
            return "valid"
        return "invalid"

validate >> process            # if no match, falls through to default
validate - "valid" >> process  # explicit
validate - "invalid" >> reject
```

If a node returns an action that has no registered successor, the flow ends there. This is the natural way to terminate.

## Shared-state contract

- `shared` is a plain Python dict. Pass any JSON-serializable values plus other Python objects (the orchestrator never serializes).
- **Never mutate `shared` from `exec`.** Mutate from `prep` (rare) or `post` (common). This is what makes retries idempotent.
- `prep_res` is the *snapshot* of input that `exec` runs on. Treat it as immutable.

## Worked patterns

### Sequential steps with branching

```python
class CheckSelectors(Node):
    def prep(self, shared): return shared["config_path"]
    def exec(self, path): return load_and_compare(path)
    def post(self, shared, prep, res):
        shared["drift_count"] = res["drift_count"]
        return "drift" if res["drift_count"] > 0 else "clean"

class Repair(Node):
    def exec(self, _): return run_repair()
    def post(self, shared, _, res):
        shared["repaired"] = res
        return "default"

class Report(Node):
    def post(self, shared, _, _r):
        print(f"Done. Drift: {shared.get('drift_count')}, Repaired: {shared.get('repaired')}")

check, repair, report = CheckSelectors(), Repair(), Report()
check - "drift" >> repair >> report
check - "clean" >> report
flow = Flow(start=check)
flow.run({"config_path": "/path/to/probe.json"})
```

### Parallel batch

```python
class EnrichOne(AsyncNode):
    async def exec_async(self, prospect):
        return await fetch_details(prospect["id"])

class EnrichAll(AsyncParallelBatchNode):
    async def prep_async(self, shared): return shared["prospects"]
    async def exec_async(self, prospect): return await EnrichOne().exec_async(prospect)
    async def post_async(self, shared, prep, results):
        shared["enriched"] = results
        return "default"
```

## Running a flow

Flows are plain Python files. The runner script `packages/bridge/scripts/run-flow.mjs` sets `PYTHONPATH` to the vendored PocketFlow and spawns `python3 flow_file.py`. The flow file ends with:

```python
if __name__ == "__main__":
    import json, sys
    shared = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    flow = build_flow()
    flow.run(shared)
    json.dump(shared, sys.stdout)
```

The runner pipes shared-state JSON in via stdin and reads the final state from stdout. This is the contract for flows that want to be invoked from pi-mono or scripts.

## Anti-patterns

- **Don't put long-running work in `prep` or `post`.** Those are for I/O against `shared`. Long work goes in `exec` so retries work.
- **Don't return a non-string from `post`.** The action lookup is `successors[action]` and only strings are registered.
- **Don't share state via globals.** Use the `shared` dict. Globals defeat the model and break parallel batch.
- **Don't subclass `Flow` to add behavior.** Add a wrapping node instead. `Flow` itself is the orchestrator; treating it as a base for business logic gets messy.

## When PocketFlow is not the right tool

- **Single-step work.** A flow framework adds nothing for one operation.
- **Conversation loops.** PocketFlow is for workflows, not chat. The agent's primary loop stays in pi-mono; pi-mono *calls* flows when work is multi-step.
- **Heavy state machines.** If you have 20+ nodes with complex history-dependent transitions, you want a real state machine library. PocketFlow's branching is for "do this, then maybe that" not "transition based on the last 5 events."

## References

- Source: `packages/bridge/vendor/pocketflow/__init__.py` (read it — 99 lines)
- Cookbook: `~/repos/PocketFlow/cookbook/` (60+ working examples)
- Examples for this repo: `examples/flows/` (start with `hello.py`)
- Integration plan: `plans/pocketflow-integration.md`
