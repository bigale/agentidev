# ADR 001: Browser ESB replaces bridge as the runtime

**Date:** 2026-05-18
**Status:** Accepted

## Context

The bridge server (`packages/bridge/server.mjs`) is a Node.js process that has accumulated ESB-shaped responsibilities: service routing, channel-style RestDataSource proxy, scheduling, AI-generation calls, script orchestration, sessions. The browser is increasingly capable of doing the same work via SW + IndexedDB + WASM. `plans/zato-alt.md` analyzes the stack.

## Decision

The Browser ESB (Hono in SW + RxDB + XState v5 + Zod + Croner + BroadcastChannel) becomes the **primary runtime**. The bridge server degrades to a thin host-helper that only owns capabilities the browser genuinely cannot do (Playwright launch, fs.watch on the script directory, V8 inspector relay).

## Why

- Bundle and boot of the Browser ESB stack is ~200–280 KB gzipped, < 1s cold (per zato-alt.md). Bridge process startup is ~2s + Node deps.
- Local-first ethos: the project already treats the browser as the canonical data store (IndexedDB, no cloud). Moving service routing to the same locus removes a round-trip.
- The "thin host helper" carve-out is minimal and stable — it only contains things the browser cannot do at all, not things it does worse.

## Alternatives considered

1. **Full bridge deprecation** — drop Playwright sessions, V8 debugging, fs.watch entirely. Rejected: those capabilities are genuinely useful for test-and-debug workflows and have no in-browser substitute.
2. **Two-runtime peer model** (per earlier memory) — bridge and Browser ESB coexist as ESBs, speaking the same envelope protocol. Rejected: keeps the bridge growing as a parallel ESB, doubles surface area, and the win of "the browser can speak Zato's protocols too" doesn't require the bridge to remain an ESB.

## Consequences

- Most of `packages/bridge/server.mjs` migrates into the extension SW + offscreen worker.
- The bridge keeps a stable, smaller surface area documented in [`docs/contexts/host-helper/CONTEXT.md`](../contexts/host-helper/CONTEXT.md).
- Existing terms (Service, Channel, Registry, Session, Script) need to be re-pinned in [UBIQUITOUS_LANGUAGE.md](../UBIQUITOUS_LANGUAGE.md) to reflect their new homes.
- Zato integration via REST channels (per `.claude/rules/restdatasource-zato.md`) is unaffected — Zato remains an out-of-process integration target.
