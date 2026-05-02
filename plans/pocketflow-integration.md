# PocketFlow Integration

A plan for adopting [PocketFlow](https://github.com/The-Pocket/PocketFlow) into the agentidev stack and making the pi-mono agent a PocketFlow expert. PocketFlow is a 99-line Python LLM framework with zero dependencies — the entire core is `Node`, `Flow`, `BatchNode`, and async variants of those. It's a pure graph abstraction; everything else (RAG, multi-agent, workflows) is built on top in the cookbook.

This plan is *not* "replace the existing stack with PocketFlow." It's "let PocketFlow earn specific roles where the graph abstraction is the right primitive."

## Why now

Two reasons:

1. **The existing run-plan system is reinventing PocketFlow's `Flow` abstraction badly.** The TreeGrid + scheduled-step + parent/child model in `extension/lib/handlers/datasource-handlers.js` is a flow graph — but ad hoc, with no real lifecycle hooks, no batch/async semantics, and no retry policy. PocketFlow gets all of that in 99 lines.

2. **Per the consulting thesis, the practice ships *workflows* — multi-step automations that combine browser automation, Zato services, LLM calls, and Convex/SQL writes.** Today those workflows live as bespoke `.mjs` scripts in `~/.agentidev/scripts/`. A flow framework with explicit prep/exec/post lifecycle, snapshot-able shared state, and retries is a better unit of delivery than a freeform script.

PocketFlow is also small enough to read in 10 minutes and short enough to embed inline if vendor risk ever became real. The downside cost is nearly zero.

## What PocketFlow gives us

The whole framework is three patterns:

```python
# Lifecycle: prep pulls inputs from shared, exec does work, post writes back
class MyNode(Node):
    def prep(self, shared): return shared["query"]
    def exec(self, query): return search(query)
    def post(self, shared, prep_res, exec_res):
        shared["results"] = exec_res
        return "default"  # or "branch_a" to take a different successor

# Composition: >> for default transition, - "action" >> for conditional
node_a >> node_b
node_b - "found" >> node_c
node_b - "missing" >> node_d

# Orchestration: Flow walks the graph, threading shared state
flow = Flow(start=node_a)
flow.run({"query": "tampa dentists"})  # mutates shared in place
```

Free with this abstraction:

- **Retries with exponential wait** (`Node(max_retries=3, wait=5)`)
- **Batch processing** (`BatchNode` runs `exec` over a list)
- **Async / parallel async / parallel batch** (`AsyncNode`, `AsyncParallelBatchNode`)
- **Conditional branching** without writing if/else trees
- **Inspectable shared state** — debugging is just `print(shared)` between nodes

What we *don't* get (and don't need from PocketFlow): vendor wrappers, prompt templates, agent abstractions. Those are deliberately out — the cookbook shows how to build them, but the core stays pure.

## Stack-fit analysis

Where PocketFlow earns its place vs. where it doesn't:

| Use case | PocketFlow? | Why |
|---|---|---|
| Run plans (the TreeGrid feature) | **Yes** — replace the bespoke executor | The graph abstraction is exactly what's being approximated. Existing run-plan persistence model maps cleanly. |
| Multi-step research/RAG flows that pi-mono delegates to | **Yes** | Lifecycle + shared state + retries are real wins. |
| API-to-app pipeline | **Yes — refactor candidate** | Currently a procedural `.mjs` script. Each step (analyze → run-pict → generate-tests) is a node. Branch on coverage findings. |
| Selector-drift / verify-selectors workflow | **Yes** | Already conceptually a flow (probe → diff → repair). PocketFlow gives explicit retry on the LLM-repair step. |
| Single-shot Zato service calls from the bridge | No | One step doesn't need a flow framework. |
| SmartClient grid CRUD | No | Already declarative. Flow framework adds nothing. |
| Pi-mono's primary conversation loop | No | That's an agent loop, not a workflow. PocketFlow can be a *tool* the agent calls. |
| The bridge server itself | No | It's a router. Routers aren't flows. |

Decision rule: **if the work has 3+ steps with state passed between them, and at least one step can fail or branch, PocketFlow earns a try. Otherwise stick with the existing primitive.**

## Three integration patterns

### Pattern A — PocketFlow as a tool pi-mono calls

The pi-mono agent has a tool surface (current tools listed in `extension/sidepanel/agent/agent-tools.js`). Add `flow_run` and `flow_define`:

- `flow_define({ name, source })` — saves a PocketFlow Python script to disk under `~/.agentidev/flows/<name>.py`. Validates the source loads (syntax check, no execution).
- `flow_run({ name, shared })` — bridge spawns a child Python process, executes the flow with the supplied shared state, returns the final shared state + last action. Streams progress events back.

The agent uses these for any multi-step task: "research these 5 prospects in parallel, summarize the findings," "verify all selectors and repair the ones that drift," "for each new GitHub issue, classify and triage." The flow is the unit of work; pi-mono is the operator.

This is the cheapest pattern to ship — no UI changes, no protocol changes. Bridge already has a child-process spawn pattern (`launchScriptInternal`).

### Pattern B — Run Plans become PocketFlow flows

The current run-plan model:
- A plan has steps. Each step is a script invocation with args.
- Steps run serially. `stopOnFailure` is a per-step flag.
- No conditional branching, no shared state between steps, no retries.

The PocketFlow-backed model:
- A run plan *is* a PocketFlow `Flow`.
- Each step is a `Node` whose `exec` calls the bridge to run a script and waits for its `BRIDGE_SCRIPT_RUN_COMPLETE` broadcast.
- `post` reads the script's exit code/assertions to decide the next action: `"success"`, `"failure"`, or `"skip"`.
- Conditional branching via `step_a - "failure" >> recovery_step` becomes natural.
- Shared state replaces "args" — earlier steps can write to shared, later steps read.

The TreeGrid UI stays the same; the editor produces a flow definition instead of a list of steps. Run-plan storage moves from `~/.agentidev/run-plans/<id>.json` to `~/.agentidev/flows/<id>.py`. Backward-compat shim converts old plans to flow scripts on first load.

### Pattern C — CheerpX as the privacy-first flow runtime

PocketFlow has zero dependencies. CheerpX runs Python in the browser via WASM. Combine them: a flow can run *entirely in the user's browser*, with no bridge round-trip, no server-side compute, and no data egress.

Pattern C is the agentidev thesis made concrete:

- The pi-mono agent (running in the extension) decides to execute a flow.
- It loads the flow's Python source into the CheerpX runtime tab.
- The flow's `exec` calls hit Ollama (local LLM) or the bridge's WebLLM provider — never an external API.
- Shared state lives in IndexedDB. No data ever leaves the device.

This is the differentiator that "AI consultancy" pitches don't have. "Your data, your compute, your model — and an audit-ready trace of every node that ran" is the marketing line.

The catch: CheerpX has the spawn-queue limitation (per memory `cheerpx-limitations.md`). PocketFlow's pure-Python flows don't spawn subprocesses, so they should be safe — but verify before committing the architecture.

## Agent skill: making pi-mono a PocketFlow expert

For pi-mono to author and reason about flows, it needs to know PocketFlow as well as it knows JavaScript. Three deliverables:

1. **Skill file at `extension/sidepanel/agent/skills/pocketflow.md`.** Same format as the other agent skills (system prompt context loaded when relevant). Distills the 99 lines into the rules pi-mono needs:
   - The lifecycle (`prep` → `exec` → `post`) and what each does
   - Transition syntax (`>>` default, `- "action" >>` conditional)
   - When to use `Node` vs `BatchNode` vs `AsyncNode` vs `AsyncParallelBatchNode`
   - The shared-state contract (mutate via `post`, not in `exec`)
   - The "fail-cheap, retry-once" rule for `Node(max_retries=2, wait=1)`

2. **Reference cookbook in the vector DB.** Index the PocketFlow cookbook (60+ working examples) into the `reference` partition of `extension/lib/vectordb.js`. Use `index-showcase.mjs` pattern. When pi-mono is asked to author a flow, semantic search retrieves the closest cookbook example as a few-shot.

3. **Worked-example library at `~/.agentidev/flows/examples/`.** A handful of flows that solve agentidev-specific tasks: `verify-and-repair-selectors.py`, `enrich-prospect-from-maps.py`, `classify-and-triage-inbox.py`. These are pi-mono's "I've seen this shape before" library.

The agent skill loads on agent boot via `agent-setup.js`. The vector-DB reference is queried lazily when pi-mono is composing a flow.

## The tutorial repo as a tool

[PocketFlow-Tutorial-Codebase-Knowledge](https://github.com/The-Pocket/PocketFlow-Tutorial-Codebase-Knowledge) is itself a PocketFlow app: it crawls a GitHub repo and generates a beginner-friendly tutorial. We use it two ways:

- **As a worked reference for how to build a real PocketFlow app.** Read its `flow.py` and `nodes.py` while authoring our own flows.
- **As a skill that pi-mono can invoke.** "Generate a tutorial for the construction client's existing codebase" becomes one tool call. The output goes into the engagement's repo as onboarding material. Per the consulting thesis (Phase 5+), this is a *deliverable*, not just a dev convenience.

The hosted version at code2tutorial.com works without install, so we can lean on it before deciding whether to host our own.

## Runtime decision: CheerpX vs bridge vs both

Three runtimes for flows, each with different tradeoffs:

| Runtime | Latency | Privacy | LLM access | Spawn cost |
|---|---|---|---|---|
| **CheerpX** (in-browser Python via WASM) | High (WASM startup ~25s) | Maximum (no data egress) | Ollama/WebLLM only | Spawn-queue limit (memory note) |
| **Bridge** (Python child via `launchScriptInternal`) | Low | Medium (data on local box) | Any provider via bridge | Cheap (~100ms spawn) |
| **Convex `runAction`** (out-of-scope per earlier discussion) | Network-bound | Lowest | Whatever Convex `runAction` supports | N/A — managed |

**Default to bridge.** It's the lowest-friction path, matches the existing script-launch pattern, and keeps the development loop tight. Use CheerpX for flows where privacy is the explicit selling point (engagements that require it, or prospect demos that pitch on-device privacy). Don't use Convex unless an engagement is already on Convex for other reasons.

The flow source is the same Python file in all three cases — what changes is where the `child_process.spawn` (or its CheerpX/Convex equivalent) happens. That's the architectural payoff: write the flow once, host it where the engagement requires.

## Phased rollout

Smallest viable steps; each phase has done-when criteria.

### Phase 1 — Read PocketFlow into the workshop (1 day)

- Vendor `pocketflow/__init__.py` into `packages/bridge/vendor/pocketflow/__init__.py` so the bridge can spawn flows without an external pip install at runtime. Also add `pip install pocketflow` to the bridge's optional dev deps for local Python development.
- Add the skill file at `extension/sidepanel/agent/skills/pocketflow.md`. Include the lifecycle rules, transition syntax, and a 20-line annotated example.
- Author one trivial flow (`hello.py` — three nodes, one branch, no LLM) and run it via the bridge by hand. Confirm shared-state in/out works end-to-end.

**Done when:** A flow runs from a `node packages/bridge/scripts/run-flow.mjs hello.py` invocation and prints the final shared state.

### Phase 2 — Pi-mono can author + run flows (3-5 days)

- Add `flow_define` and `flow_run` to `extension/sidepanel/agent/agent-tools.js`.
- Add the bridge handlers `BRIDGE_FLOW_DEFINE` (writes `~/.agentidev/flows/<name>.py`) and `BRIDGE_FLOW_RUN` (spawns Python child, streams progress, returns final state).
- Index the PocketFlow cookbook into the `reference` vector partition (one-shot script: `packages/bridge/scripts/index-pocketflow-cookbook.mjs`).
- Test: ask pi-mono "verify all my Maps selectors and repair any that drift." It should compose a flow, run it, return results.

**Done when:** Pi-mono successfully authors and executes one non-trivial flow without manual intervention.

### Phase 3 — One existing workflow ported to PocketFlow (3-5 days)

- Pick the strongest candidate: `verify-selectors` + `repair-selectors` (currently two separate `.mjs` scripts that share concepts but not state).
- Port to a single PocketFlow flow with three nodes: `Probe` → (branch on drift) → `Repair` → `Verify`. Retry policy on `Repair` (LLM call).
- Replace the two scripts in `consulting-template/scripts/` with the flow + a thin `.mjs` shim that invokes it via the bridge (so existing run plans keep working during transition).

**Done when:** The flow runs in the dashboard's Run Plans tab, succeeds end-to-end against a real selector drift scenario, and the old `.mjs` scripts are deleted.

### Phase 4 — Run Plans become flows (1-2 weeks)

- New flow-based run-plan executor that replaces the current step-by-step runner. Backward-compat: existing run plans (JSON files) auto-migrate to flow scripts on first load.
- TreeGrid UI updates to show conditional branches (steps with `- "failure" >>` arrows).
- The Schedules feature triggers flows the same way it triggers scripts today (cron + `BRIDGE_FLOW_RUN`).

**Done when:** All existing run plans run as flows, conditional branching is supported in the UI, no regression in scheduled execution.

### Phase 5 — CheerpX runtime as opt-in (after a real demand)

Don't build until an engagement asks for it. When the demand appears, the work is: load CheerpX, embed the vendored `pocketflow/__init__.py`, route LLM calls to Ollama via existing extension wiring, IndexedDB-backed shared state. Estimated 1 week with an engagement deadline forcing the decision.

## Open questions

- **Where does flow source live in the repo layout?** Likely in `consulting-template/flows/` (per-engagement) and `agentidev/examples/flows/` (framework examples). Per-engagement flows would be private; framework examples would be MIT.

- **Does the dashboard need a flow editor?** Possibly Phase 6+. For now, flows are authored in `~/.agentidev/flows/<name>.py` via the file watcher pattern (already exists for scripts). Pi-mono can read/write them directly.

- **Visualization?** PocketFlow flows can be rendered as Mermaid diagrams trivially (walk the graph, emit nodes + edges). The Run Plans TreeGrid could display the flow graph as a diagram. Nice-to-have, not blocking.

- **Type checking?** PocketFlow is plain Python with no typing. Mypy would help for shared-state contracts but isn't necessary in Phase 1-4. Pick up if engagements complain.

- **What about the AsyncFlow rules?** Re-reading the source: an AsyncFlow can contain both AsyncNode and (sync) Node — the orchestrator dispatches correctly. So async vs sync is per-node, not per-flow. Document this in the skill file because it's surprising.

## What this is *not*

- Not a replacement for pi-mono. PocketFlow is a tool pi-mono uses; it doesn't replace the conversational agent loop.
- Not a replacement for Zato. Zato is the integration spine for *external* systems (EDI, partner APIs, scheduled jobs over OS resources). PocketFlow is for *internal* multi-step orchestration.
- Not the marketing pitch. The pitch is still "AI-augmented integration practice running on a tight loop." PocketFlow is the implementation detail that makes one of the loops tighter.

## References

- PocketFlow source: `~/repos/PocketFlow/pocketflow/__init__.py` (99 lines)
- PocketFlow cookbook: `~/repos/PocketFlow/cookbook/` (60+ examples including `pocketflow-agent-skills`)
- Tutorial repo: `~/repos/PocketFlow-Tutorial-Codebase-Knowledge/` (a real PocketFlow app)
- Hosted tutorial generator: https://code2tutorial.com/
- Existing run-plan handlers: `extension/lib/handlers/datasource-handlers.js` (RunPlans backend)
- Existing run-plan UI: `extension/smartclient-app/dashboard/run-plans.js`
- Pi-mono agent setup: `extension/sidepanel/agent/agent-setup.js`
- Pi-mono tools: `extension/sidepanel/agent/agent-tools.js`
- Vector DB partitions: `.claude/rules/vectordb.md`
