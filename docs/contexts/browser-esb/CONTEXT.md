# Browser ESB

The primary runtime, per [ADR 001](../../adrs/001-browser-esb-replaces-bridge-as-runtime.md). Lives in the extension's service worker, offscreen document, and sandbox iframe. Replaces the bridge server as the architectural center.

## Stack

Per `plans/zato-alt.md`:

- **Hono** in the Service Worker — HTTP Channel for inbound calls
- **Comlink** — RPC Channel (Worker ↔ main thread)
- **Croner** — cron Channel
- **BroadcastChannel + RxDB collection** — topic Channel
- **RxDB 17** on IndexedDB — persistence + reactive queries + durable topic replay
- **XState v5** — long-running Jobs (actor-shaped state machines)
- **Zod 4** — SIO validation
- **ky** — Outgoing connection HTTP client
- **YAML manifest** parsed at boot — declarative config (the Zato analog of `service.conf`)

## Ownership

Owns:
- ServiceRegistry — all Service definitions
- Channel adapters (HTTP/RPC/cron/topic)
- Outgoing connections (ky, RxDB replication, LLM providers, etc.)
- DataSource backings (each SmartClient DataSource binds to one Service or a CRUD quartet of Services)
- Jobs (long-running in-browser automations)
- Topics (named cross-context streams)
- Manifest reload (the fast-path "hot deploy")
- Plugins — deployable bundles that contribute to the Manifest
- Agents — LLM-driven Actors with persistent state in RxDB
- Tools — Services flagged as agent-callable (an annotation, not a separate primitive)
- Conversations — durable message logs in RxDB

Does **not** own:
- Playwright Sessions or Scripts (those live in Host Helper)
- The Service Worker code itself (changing it requires SW update, slow path)
- componentRegistry (per-app, owned by the SmartClient renderer)

## Invariants

1. Every Service is channel-agnostic — the same `invoke(input, ctx)` works through HTTP, RPC, cron, or topic.
2. Correlation IDs are generated at the inbound Channel edge if absent, threaded through `Ctx`, echoed on response.
3. SIO is enforced via Zod on both `input` and `output` of every Service.
4. The ServiceRegistry is the single source of truth for which Services exist; channels look up by name.
5. `BRIDGE_BACKENDS` (legacy DS routing) and the existing handler files in `extension/lib/handlers/` migrate into Services with HTTP channel bindings.

## Boundary contract with Host Helper

The Browser ESB calls Host Helper through a single WebSocket connection (the existing port-9876 wire), but only for capabilities the browser cannot do itself:

- Request Host Helper to launch / stop a Playwright Session
- Request Host Helper to spawn a Script
- Sync source files for Scripts (push/pull via Host Helper's `fs.watch`)
- Relay V8 inspector events (debug only)

The Browser ESB does **not** delegate service routing, scheduling, DS proxy, or AI generation to Host Helper.