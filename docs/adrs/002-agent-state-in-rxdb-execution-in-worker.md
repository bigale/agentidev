# ADR 002: Agent state in RxDB, execution in an on-demand Worker

**Date:** 2026-05-18
**Status:** Accepted

## Context

The pi-mono Agent today lives in the sidepanel JS context. Conversation history persists separately, but the Agent itself is reconstructed each time the sidepanel opens. We need to decide where the Agent lives in the Browser ESB world, because the choice affects lifetime, identity, and the ability to do background or scheduled agent work.

## Decision

Agent **state** — the XState Actor snapshot, conversation pointer, model config, tool list, RAG transform configuration — lives in an RxDB collection. Agent **execution** runs in a Worker that is spawned on demand:

- The sidepanel spawns a Worker to host the Agent for interactive chat.
- The SW spawns a Worker for scheduled or background invocations.
- Other UI surfaces (future sidebars, popups) attach to the same persistent Agent state via the same Worker-spawn pattern.

The sidepanel becomes a **view** onto the Agent, not its home.

## Why

- **Survives sidepanel close, extension reload, and Chrome restart.** A long-running agent task (e.g., "monitor this product page for the next 24h and notify me when the price drops") cannot be tied to UI lifetime.
- **Multi-surface attachment.** The same Conversation can be rendered in the sidepanel, a sidebar, and a notification, all live via RxDB live queries — there is no single owner.
- **Aligns with the canonical Actor pattern.** XState v5's `persist`/`hydrate` snapshot API is the idiomatic way to do this; we are not inventing a mechanism.
- **Decouples Agent from Tool execution context.** Tools (Services) may run in the SW, in another Worker, or on the Host Helper — the Agent's Worker only needs to dispatch calls, not host the implementations.

## Alternatives considered

1. **Sidepanel-scoped Agent.** Simpler, but kills background agent work and re-creates the Actor on every sidepanel open — slow and stateful-feeling resets are surprising.
2. **SW-scoped Agent.** SWs are evicted after ~30s idle on Chrome. Long-lived agents require constant heartbeats or re-spawning, which is what the Worker-on-demand pattern provides anyway — without the eviction constraint.
3. **Offscreen-document-scoped Agent.** One offscreen instance per extension means multi-conversation requires multiplexing inside the offscreen doc — additional complexity for no gain over Workers.

## Consequences

- The Manifest declares an `agents` section with Agent definitions (initial state, tool list, model config, persistence policy).
- A new Service `agent.spawn(agentId)` returns a Comlink handle to a freshly-spawned Worker hosting that Agent. The sidepanel and other UIs use this Service rather than instantiating Agents directly.
- Conversation messages live in their own RxDB collection, not inside the Actor snapshot — the snapshot is a *pointer* to a Conversation so it stays small and serializable.
- Agent tool calls become Service invocations through the canonical Channel system; the Agent does not bypass the ESB.
- The pi-mono bundle (`extension/lib/vendor/pi-bundle.js`) is loaded inside the Worker rather than the sidepanel page — a measurable bundle shift but the same code.
