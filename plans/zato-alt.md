# Zato in the browser: assembling an ESB from JS/TS parts

**There is no single library that replicates Zato in a browser runtime, and there will not be one.** What you can build, by stacking roughly eight to twelve focused libraries, is a surprisingly faithful approximation of seven of Zato's twelve capability areas — enough to run a multi-channel, config-driven, persistent, observable service host inside a PWA. The three capabilities that remain genuinely weak in the browser are **durable queues with crash-safe at-least-once delivery**, **enterprise transport adapters** (AMQP, IBM MQ, JMS), and **true hot-deploy of production code**. Everything else — the Service class, SIO validation, channels, routing, scheduling, pub/sub, SQL-ish persistence, observability, and security — has a credible JS/TS analog in late 2025 / early 2026. The winning substrate is a **Service Worker running Hono** with **RxDB or Dexie on IndexedDB**, orchestrated by **XState v5 actors** and validated by **Zod/Valibot**. This report maps each Zato capability to concrete libraries, proposes three stack recipes, sketches the core patterns in code, and is blunt about the limits.

## Capability-to-library mapping

The table below collapses Zato's twelve capabilities onto concrete JS/TS choices. One-line justifications follow the spirit of Zato's own pluggable-adapter philosophy: prefer libraries that are themselves adapter-oriented.

| Zato capability | Primary JS/TS pick | Why it fits |
|---|---|---|
| Service framework (class, SIO, lifecycle) | **TypeScript class + Zod 4 (or Valibot)** | Classes give lifecycle hooks; Zod gives SIO parity with Zato's Integer/String/List. |
| Channel abstraction | **Hono in Service Worker + Comlink + BroadcastChannel** | Single `service.handle(ctx)` reused behind HTTP, RPC, and topic channels. |
| Message routing / ESB | **XState v5 actors** (minimal: mitt; maximal: RxJS 8) | Actors model long-lived addressable services; mitt is the 200-byte bus; RxJS gives enrich/transform/fan-out operators. |
| Hot deploy | **Vite 6 HMR in dev; SW `skipWaiting` + `clients.claim` in prod** | HMR for worker code in dev; SW update lifecycle is the only honest prod story. |
| Scheduler | **Croner + Periodic Background Sync fallback** | Croner parses cron in-browser; PBS keeps jobs alive when tab is closed (Chrome/Edge only). |
| Pub/sub | **BroadcastChannel across contexts; mitt in-context; RxDB changes-stream for durable topics** | Browser-native for cross-tab; RxDB collections act as persistent topics. |
| Outgoing connections | **fetch + ky/ofetch; RxDB replication plugins; nats.ws; MQTT.js** | ky wraps HTTP with retries; RxDB bundles GraphQL/CouchDB/Supabase/Firestore/NATS/WebRTC adapters. |
| Declarative config | **YAML loaded at boot into a typed registry (Zod-parsed)** | No framework ships this; build it — it is ~80 lines. |
| Persistent state / SQL | **RxDB 17 (default) or Dexie 4; PGlite for real SQL; SQLocal for SQLite/OPFS** | RxDB gives ORM-ish schemas + reactive queries; PGlite gives real Postgres in WASM. |
| Observability | **OpenTelemetry JS browser SDK + Sentry + consola/tslog** | OTel traces span fetch/SW boundaries; Sentry for errors; consola for structured logs. |
| Security | **jose + oauth4webapi + CASL + WebAuthn** | jose handles JWT verify/sign; oauth4webapi is the OIDC primitive; CASL is isomorphic RBAC. |
| Pluggable transports | **RxDB replication plugin system + custom Hono middleware** | RxDB's plugin surface is the closest thing in JS to Zato's adapter pattern. |

A few non-picks deserve mention. **Temporal's TypeScript SDK is not a browser option**: it requires Node.js 20+, `async_hooks`, and a Rust-built native core — the docs are explicit that only `@temporalio/client` has been observed to work in non-Node runtimes, and Worker execution needs real Node. **Inngest, DBOS, and Restate** are server-first; they have no browser runtime. **tRPC v11** works beautifully but is RPC over HTTP — it is an application of the channel layer, not the channel layer itself. **BullMQ has no browser port**; the closest analog is RxDB's `RxPipeline` plugin (added in 2025) combined with a retry-queue collection you write yourself.

## Three stack recipes

### Minimal — the "I need the Zato feeling in 1,500 lines" stack

**Libraries:** Dexie 4, Zod 4, Comlink 4, mitt 3, Hono 4 (in a Service Worker), Croner 9. Roughly 55 KB gzipped, all in.

```
 ┌────────────────────────── Main thread (UI) ───────────────────────┐
 │  Comlink.wrap(worker) ──► service proxy (typed)                   │
 │  fetch('/api/orders')   ──► intercepted by SW                     │
 └────────┬──────────────────────────┬───────────────────────────────┘
          │ postMessage              │ fetch event
          ▼                          ▼
 ┌── Web Worker ───────────┐   ┌── Service Worker ────────────┐
 │  ServiceRegistry        │◄──┤  Hono app — routes → services│
 │  ├─ OrderService (Zod)  │   │  (SW is the "HTTP channel")  │
 │  ├─ mitt event bus      │   └──────────────────────────────┘
 │  └─ Croner scheduler    │
 │  Dexie (IndexedDB) ─────┘
 └─────────────────────────┘
```

The pattern is: one `Service` base class, each service exposes `handle(input, ctx)` that is called from **three channel adapters** — a Hono route (HTTP), a Comlink method (in-page RPC), and a Croner tick (schedule). Mitt is the in-worker bus; Dexie is persistence. **What's missing vs. Zato**: no offline-server sync, no workflow orchestration, no tracing, security is whatever you bolt onto Hono middleware, and "hot deploy" is Vite HMR in dev only.

### Balanced — the production PWA stack

**Libraries:** **RxDB 17** (on IndexedDB or OPFS), **Zod 4**, **Hono 4** (Service Worker), **Comlink**, **XState v5** + `@xstate/store`, **Croner**, **BroadcastChannel**, **Sentry browser**, **ky** (outgoing HTTP), **CASL** (authorization), **oauth4webapi** + **jose** (OIDC/JWT).

```
   ┌──────── UI (React / Svelte / Solid) ────────┐
   │  useQuery/useZero-style reactive hooks      │
   └────┬────────────────┬──────────────────┬────┘
        │ Comlink        │ fetch            │ BroadcastChannel
        ▼                ▼                  ▼
 ┌── Web Worker ───┐  ┌── Service Worker ─┐  ┌─ Other tabs ─┐
 │ XState system   │  │ Hono + auth mw    │  │ share topics │
 │  ├─ actors =    │◄─┤ /api/* → actors   │  └──────────────┘
 │  │  services    │  │ Workbox caches    │
 │  ├─ router      │  └───────────────────┘
 │  └─ scheduler   │           ▲
 │ RxDB collections│           │ HTTP out (ky)
 │  with live$     │           ▼
 └─────────────────┘    REST/GraphQL backends
          │
          └── RxDB replication (Supabase/Firestore/CouchDB/GraphQL) ─► server
```

The **config-driven** feel comes from loading a YAML (or TS) manifest at boot that declares services, channels, and outgoing connections; a 100-line bootstrap parses it with Zod and registers XState actors, Hono routes, Croner jobs, and RxDB replication handlers. **What's missing vs. Zato**: no crash-durable job queue (if the tab dies mid-retry, retries depend on whether your PBS registration survived); no AMQP/JMS; tracing is still best-effort.

### Maximal — the "I am building Linear-plus-Zato" stack

Add to Balanced: **PGlite** (real Postgres in WASM via OPFS) as an optional second store for services that need SQL, **Drizzle ORM** on top of PGlite, **Rocicorp Zero** or **ElectricSQL + TanStack DB** for server-authoritative sync, **Yjs** for any collaborative document, **OpenTelemetry JS browser SDK** with a custom exporter that batches to a server ingest, **nats.ws** or **MQTT.js** for a real external message bus, **Workbox 7** for cache policies, **@simplewebauthn/browser** for passkeys, and a self-built **saga coordinator** on top of XState v5 actors (the `fromPromise` logic + compensating transitions is the idiomatic XState pattern for sagas).

```
 ┌──── UI ────┐
 └─┬──────────┘
   ▼
 ┌── Shared Worker (broker) ──┐    BroadcastChannel ── tabs
 │  in-browser topic broker   │──► nats.ws ─► NATS cluster (optional)
 │  saga coordinator (XState) │
 └─┬────────────────────┬─────┘
   ▼                    ▼
 ┌── Web Worker pool ─┐  ┌── Service Worker ──┐
 │ service actors     │  │ Hono (channels):   │
 │ RxDB + PGlite      │  │  /api/*, /webhook/*│
 │ Drizzle (SQL)      │  │ OTel fetch instr.  │
 └────────────────────┘  └────────────────────┘
           │                      │
           ├── Zero/Electric sync ┤
           └── OTel export ───────┘
```

**What's still missing vs. Zato** even here: no at-least-once delivery across a hard browser crash (only the server-side NATS/MQTT side offers that), no AMQP/JMS/IBM MQ adapters, no server-side key material (every secret is either user-bound or public), and "hot deploy" still means a new Service Worker version with the standard update-after-reload dance.

## Service-framework pattern: a Zato-like class in TypeScript

The code sketch below shows the core idiom — one service class exposed over three channels, validated by Zod, persisted through Dexie, correlation-ID-aware. It is deliberately terse; in production you split the registry, channels, and services into separate modules.

```ts
// --- service-base.ts ----------------------------------------------------
import { z, ZodTypeAny } from 'zod';
import { nanoid } from 'nanoid';

export interface Ctx {
  cid: string;                       // correlation id
  log: (msg: string, extra?: object) => void;
  channel: 'http' | 'rpc' | 'cron' | 'topic';
  db: DexieDB;                       // injected
  emit: (topic: string, payload: unknown) => void;
}

export abstract class Service<I extends ZodTypeAny, O extends ZodTypeAny> {
  abstract name: string;
  abstract input: I;
  abstract output: O;
  abstract handle(data: z.infer<I>, ctx: Ctx): Promise<z.infer<O>>;

  async invoke(raw: unknown, ctx: Partial<Ctx> & { db: DexieDB; emit: Ctx['emit'] }) {
    const cid = ctx.cid ?? nanoid(12);
    const log = (m: string, extra = {}) =>
      console.log(JSON.stringify({ t: Date.now(), cid, svc: this.name, m, ...extra }));
    const parsed = this.input.parse(raw);           // SIO in
    log('start', { channel: ctx.channel });
    const out = await this.handle(parsed, { ...ctx, cid, log } as Ctx);
    log('done');
    return this.output.parse(out);                   // SIO out
  }
}

// --- services/create-order.ts ------------------------------------------
export class CreateOrder extends Service<typeof In, typeof Out> {
  name = 'order.create';
  input = In; output = Out;
  async handle(data: z.infer<typeof In>, ctx: Ctx) {
    const id = nanoid();
    await ctx.db.orders.add({ id, ...data, createdAt: Date.now(), cid: ctx.cid });
    ctx.emit('order.created', { id, cid: ctx.cid });    // pub/sub
    return { id };
  }
}
const In  = z.object({ sku: z.string(), qty: z.number().int().positive() });
const Out = z.object({ id: z.string() });

// --- registry.ts --------------------------------------------------------
export const registry = new Map<string, Service<any, any>>();
registry.set('order.create', new CreateOrder());

// --- channel-http.ts  (runs in the Service Worker) ---------------------
import { Hono } from 'hono';
import { handle } from 'hono/service-worker';
const app = new Hono();
app.post('/api/:svc', async (c) => {
  const svc = registry.get(c.req.param('svc'));
  if (!svc) return c.json({ error: 'not found' }, 404);
  const cid = c.req.header('x-correlation-id') ?? nanoid(12);
  const out = await svc.invoke(await c.req.json(),
    { cid, channel: 'http', db, emit });
  return c.json(out, 200, { 'x-correlation-id': cid });
});
self.addEventListener('fetch', handle(app));

// --- channel-rpc.ts  (runs in a Web Worker) ----------------------------
import * as Comlink from 'comlink';
Comlink.expose({
  invoke: (name: string, data: unknown, cid?: string) =>
    registry.get(name)!.invoke(data, { cid, channel: 'rpc', db, emit }),
});

// --- channel-cron.ts  (runs in the same Web Worker) --------------------
import { Cron } from 'croner';
new Cron('*/5 * * * *', () =>
  registry.get('order.reconcile')!.invoke({}, { channel: 'cron', db, emit }));
```

The **three channels call the same `invoke`**, which means the service is genuinely channel-agnostic — the Zato property you care about most. Correlation IDs are generated at the channel edge if absent, threaded through context, and echoed on the response header. The `emit` function is a wrapper around `BroadcastChannel.postMessage` plus a Dexie insert into an `events` table for a durable audit log, giving you lightweight pub/sub plus replay.

## Routing and ESB: four approaches, one recommendation per tier

**Event bus (mitt, nanoevents).** The minimal approach. ~200 bytes, zero semantics beyond `on/emit`. Use for Minimal. No ordering guarantees, no wildcard matching, no backpressure. It is perfect for a single-worker in-memory bus and nothing more.

**Observable streams (RxJS 8).** The most expressive option for *transformation-heavy* pipelines — `mergeMap`, `retryWhen`, `bufferTime`, `groupBy` let you build enrichers and fan-outs declaratively. ~35 KB. It models routing as dataflow graphs, which is a surprisingly close match to Zato's pipe-and-filter services. Its weakness is that streams aren't addressable — there's no "tell actor X" semantics.

**Actor model (XState v5, Nact).** The best fit for Zato's service-oriented mental model. In XState v5 every service *is* an actor with a `send(event)` mailbox, invoked children, persistent snapshots, and typed events. `@xstate/store` gives a lightweight per-service store. You get saga-style compensation naturally via parallel states and `onError` transitions. Nact is leaner and more Erlang-like but has less momentum. **Recommend for Balanced and Maximal.**

**Pub/sub (BroadcastChannel, in-memory topic broker).** Native BroadcastChannel handles cross-tab/cross-worker messaging for free; it has no persistence and no replay. Pair it with a tiny IndexedDB-backed topic log (an RxDB collection works) for durable topics within a single origin. For cross-origin or server-mediated pub/sub, use **nats.ws** or **MQTT.js** — both run in the browser over WebSocket.

**Workflow engine.** **Temporal's TS SDK does not run in the browser**, full stop — it needs Node's `async_hooks` and a native Rust core. Inngest, DBOS, Restate are also server-only. The honest in-browser alternative is XState actors with persisted snapshots (store the snapshot JSON in IndexedDB after each transition), which gives you durable resumption *if the tab comes back* but not crash-recovery semantics. For true durable workflows, keep a server.

**Recommendation by tier:** mitt for Minimal, XState v5 for Balanced, XState v5 + RxJS pipelines + optional nats.ws for Maximal.

## Honest gap analysis

The browser **cannot** match Zato on five axes, and pretending otherwise will bite you.

**Durable queues with at-least-once across crashes** are not achievable. IndexedDB is durable, but the *process* isn't: if the user force-quits the browser mid-retry, the tab is dead until they reopen it. Periodic Background Sync helps on Chrome/Edge but is (a) not available in Safari or Firefox, (b) capped at once-per-12-hours minimum interval by the UA, and (c) revocable by the user. You can build an at-least-once append log on top of RxDB, but "delivery" resumes only when a tab is alive.

**Cross-process / cross-origin message bus.** BroadcastChannel is same-origin only. SharedWorker is not supported in mobile Safari as of early 2026. True cross-process bus requires a server-side broker you connect to via nats.ws, MQTT.js, or a Phoenix Channels / Centrifugo client — at which point you are no longer browser-only.

**Enterprise transports (AMQP 0-9-1, AMQP 1.0, IBM MQ, JMS, SAP, Tibco).** No browser WebSocket client exists for IBM MQ. AMQP over WebSocket exists (`rhea` has browser builds, with caveats) but is hostile in practice — brokers rarely expose it, and the wire protocol assumes long-lived TCP with credit-based flow control that behaves poorly over WS. Treat this category as server-only.

**Heavy-duty persistent scheduler.** Croner + `setTimeout` survives tab reloads only if you persist the schedule and rehydrate on boot. It does not survive the tab being closed for a week. Periodic Background Sync is the only native mechanism, and its guarantees are "best effort, UA decides."

**Hot deploy of production code.** Vite HMR is dev-only. In production, the Service Worker update lifecycle is the only sanctioned path: publish new assets → SW detects update → `skipWaiting` + `clients.claim` swaps it on next navigation. There is no safe "drop a .js into IndexedDB and `eval` it" pattern in a CSP-hardened PWA, and any such pattern disqualifies the app from most corporate CSP policies. If you want Zato-style hot deploy, you want a server.

**Server-side security primitives.** Every secret in a browser is either user-scoped (OIDC token, passkey) or public. There is no notion of a service-bound API key the user cannot extract. mTLS is not available to web apps. If your Zato use case involves a shared credential that must be protected from the human operating the device, the browser is the wrong substrate.

## Local-first and optional server sync

When the app grows a server, the question becomes which sync engine feels most "Zato-like" — meaning declarative, pluggable, and channel-agnostic. The field sorted out noticeably in 2024–2025.

**RxDB** is the most Zato-like in spirit. Its 2025/2026 releases (currently 17.x) formalize the "RxDB Sync Engine" as a three-endpoint HTTP protocol, with **production plugins for GraphQL, CouchDB, WebSocket, WebRTC (P2P), Supabase, Firestore, NATS, and Google Drive**. The storage layer is separately pluggable (Dexie/IndexedDB, OPFS, SQLite, in-memory, LocalStorage, FoundationDB, DenoKV). That is the JS ecosystem's clearest instance of the "pluggable adapter" pattern Zato is built around.

**Rocicorp Zero** (version 0.23 as of October 2025, beta targeted for late 2025/early 2026) takes a different shape: query-driven partial sync where reads and writes flow through a Zero cache in front of Postgres, with `synced queries` running custom server code on the read path. Bundle is ~47 KB. Not as adapter-oriented as RxDB but has by far the best read/write latency story when a Postgres backend exists.

**ElectricSQL pivoted in 2024–2025**: it is now *read-path only* (Postgres → clients via HTTP shapes), and pairs with **TanStack DB** for the client-side reactive store with optimistic mutations. You write writes via your own API. This is a clean model when you already own the server; it does not pretend to be a full local-first DB on its own anymore.

**PowerSync** continues as a client-side SQLite (via OPFS) + server sync service, strong for RN/mobile, credible in browsers.

**Yjs and Automerge** solve a different problem: CRDT-based collaborative documents. Use them when the data model *is* collaborative (rich text, canvases, trees), not as general-purpose replicators.

**Jazz, Triplit, InstantDB, LiveStore, Replicache** all exist and ship. Jazz is the most opinionated "full-stack local-first" framework; Triplit is a local-first DB with sync; Replicache is the predecessor pattern Zero is superseding. Pick them only if their specific model clicks for your app — they are more framework than library.

**The most Zato-like combination** in this space is **RxDB + a replication plugin chosen per deployment** (Supabase for managed Postgres, CouchDB for existing CouchDB, GraphQL for custom servers). It preserves the "swap a connector, not your code" principle.

## The PWA / Service Worker angle

The Service Worker is the browser's closest analog to a running server process — it has its own lifecycle, it intercepts network requests, and it persists across tab closes. That makes it the natural home for Zato's "channel" abstraction for HTTP-style calls.

**Hono in a Service Worker is a real, documented pattern.** Hono ships `hono/service-worker` with `handle(app)` and `fire(app)` helpers; you import `Hono`, declare routes, and register the app as a fetch-event handler. The blog post "A Server in Your Browser" (rbby.dev) walks through the full pattern with Cache API, IndexedDB, and Hono RPC's typed client — the RPC feature gives you **end-to-end type safety from a Service Worker "API" to the main thread**, something Zato cannot offer because Python isn't structurally typed across the wire. Bundle is ~18 KB.

**itty-router** is the leaner alternative — tiny router, no middleware system, fine for a handful of routes. **Workbox 7** handles the caching/strategies layer (stale-while-revalidate, network-first, background sync queues) and composes cleanly with Hono — Hono routes your `/api/*` paths, Workbox manages your static asset strategies.

**MSW (Mock Service Worker)** can technically be pressed into service as a production local API, and some teams do this, but MSW's design center is request interception for tests; using it in production means opting into its handler shape and debug tooling overhead. **Prefer Hono for a real local API; keep MSW for tests.**

The channel abstraction falls out naturally: the same `registry.get(name).invoke(data, ctx)` that serves the HTTP channel in the SW is called by Comlink from the main thread and by Croner inside a Web Worker. One service, three channels, zero code duplication.

## What JS/TS genuinely does better than Zato

Zato wins on enterprise adapters, durable infrastructure, and operational maturity. The JS/TS ecosystem wins, decisively, on **four** axes.

**Reactivity**. RxDB live queries, Zero/Electric/TanStack DB collections, Signals, and Solid/Svelte runes give you "data changes → UI updates" as a first-class primitive. Zato has no story for this because it is not the problem Zato solves, but when building a UI-first product, local reactivity beats any amount of server sophistication.

**End-to-end type safety**. tRPC v11, Hono RPC, and ts-rest let a service definition on one side become a typed client on the other with zero codegen. Zato's SIO is runtime-validated but the Python type system cannot propagate types to a JS caller. In a JS/TS stack, a Zod schema *is* both the SIO validator and the TypeScript type — no duplication.

**Cold start and footprint**. A Hono-in-SW "server" loads in under 50 KB and boots in tens of milliseconds. Zato needs a process, a JVM-scale runtime (it's Python, but the baseline is server-class), and a DB. For local-only or edge-case workloads, the browser stack wins by two orders of magnitude on resource use.

**First-class async**. JS's async/await, AbortController, structured concurrency patterns via `Promise.all`/`Promise.allSettled`, and libraries like Effect-TS give you cancellation and composition semantics that Python only recently started matching with `asyncio`/`anyio`. For I/O-bound service work, JS/TS is actually more ergonomic.

Also worth naming: **streaming UI updates** (Server-Sent Events and fetch streams are trivial in JS, awkward in Python), **instant hot module reload in dev**, and the **visual tooling around XState** (the Stately editor lets you literally draw your service routing graph).

## The opinionated recommendation for late 2025 / early 2026

**If you are starting today, pick this stack and do not deliberate:**

- **Persistence**: **RxDB 17** on the Dexie storage adapter (IndexedDB). Upgrade to the OPFS storage if you need >1 GB or heavy writes. Add **PGlite** alongside only if a specific service genuinely needs SQL joins RxDB can't express.
- **Service framework**: A hand-rolled `Service` base class ~60 lines, **Zod 4** for SIO, one `registry` Map.
- **Channels**: **Hono 4** inside a Service Worker for HTTP, **Comlink 4** for main-thread-to-worker RPC, **Croner 9** for cron, **BroadcastChannel** + an RxDB `events` collection for pub/sub.
- **Routing / orchestration**: **XState v5** with `@xstate/store`. One actor per long-lived service; use `fromPromise` for request/response services. Persist snapshots to RxDB.
- **Outgoing**: **ky** for HTTP, RxDB replication plugins for databases, **nats.ws** or **MQTT.js** only if you genuinely need a message broker.
- **Config**: A YAML file parsed by Zod at boot, registering services, channels, jobs, and replications into the registry. Write the 80-line bootstrap yourself — no framework does this well.
- **Observability**: **OpenTelemetry JS browser SDK** for traces, **Sentry** for errors, **consola** for structured logs, correlation IDs threaded through `Ctx`.
- **Security**: **oauth4webapi** + **jose** for OIDC/JWT, **CASL** for RBAC, **@simplewebauthn/browser** for passkeys.
- **Sync** (when you add a server): choose based on backend — **RxDB + Supabase plugin** if Postgres-on-Supabase, **Rocicorp Zero** if you own Postgres and want query-driven sync, **ElectricSQL + TanStack DB** if you want read-sync only and handle writes via your own API.
- **Build**: **Vite 6** with `vite-plugin-pwa` for the Service Worker integration.

This stack is **roughly 200–280 KB gzipped** depending on how much of RxDB you pull in, boots in under a second on a cold cache, and gives you seven of Zato's twelve capability areas at production quality, two more at "good enough for dev," and is honest about the three it can't do. It feels like Zato in the ways that matter most to an application developer — **channel-agnostic services, declarative config, pluggable adapters, structured logging, SIO** — while conceding, as it must, that durable enterprise messaging belongs on the other side of a WebSocket.

## Conclusion

The exercise of mapping Zato onto a browser runtime clarifies what Zato actually *is*: less a framework and more a set of consistent conventions for service-oriented code behind pluggable adapters. Those conventions transfer. The infrastructure — durable queues, AMQP, server-side secrets, at-least-once delivery across crashes — does not. The JS/TS ecosystem in 2026 has caught up to roughly three-quarters of Zato's surface area, but the last quarter is structural: it belongs to a long-lived server, not a browser tab. Build the browser version when the problem is "bring Zato's ergonomics to a local-first app"; keep Zato (or a server-side equivalent) when the problem is "integrate seven enterprise systems over durable queues." The interesting architectural move, and the one most worth pursuing, is **building the browser stack to speak Zato's protocols** — correlation IDs on HTTP, a consistent service envelope, a YAML manifest — so that the browser PWA and the Zato server can co-exist as peers on the same bus rather than as alien systems.