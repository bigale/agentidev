# PICT-driven POC for a Petstore stack you can start Monday

The hypothesis holds — but only once you accept that **PICT itself does not recurse**. Its model language is flat, sub-models are strictly one level deep, and there is no `include`/`import` directive. Any "recursive PICT" architecture therefore lives in wrapper orchestration around PICT invocations, using either `/e:` TSV seeding or the C-API `PictAttachChildModel` hook to compose models. This reframes the whole POC: the LLM is not asked to write a single clever model file, it is asked to emit a **tree of small per-endpoint model files** and the glue that fans them out, stitches TSV rows back into JSON payloads, and emits a pytest-centric TDD harness that drives a Zato + SQLite + SmartClient build. The combination is implementable in roughly **three weeks of focused work**, with the first green test crossing the wire inside week one. The rest of this document grounds that claim in what PICT actually supports, shows concrete Petstore model files for three recursion patterns, picks the sweet spot, specifies the test harness, drafts the LLM system prompt, and lays out milestones, risks, and the complementary fuzz/property tools that fill PICT's gaps.

## What PICT actually supports

PICT's model language has four primitives and one orchestration hook. **Parameters** declare a name and a comma-separated finite value list (`Status: available, pending, sold`); types are inferred from content. **Aliases** (`True | true | 1`) rotate display names for a single combinatorial value but cost nothing combinatorially and do not help emit distinct payloads. **Weights** (`NTFS (10)`) are explicitly documented as "opportunistic hints, not guarantees" — PICT's own docs warn they may be ignored when coverage is indifferent, so never rely on them to enforce a target frequency distribution. **Negative values** prefixed with `~` guarantee a single-invalid-at-a-time matrix: PICT covers all valid pairs plus every combination where exactly one negative value is paired with all valid values of every other parameter, so `~-1` and `~9999` never appear together. **Constraints** are a full predicate language with `IF/THEN/ELSE`, `AND/OR/NOT`, `=/<>/</<=/>/>=`, `LIKE` (wildcards `*` and `?`), `IN {set}`, and parameter-to-parameter comparison (`IF [LANG_1] = [LANG_2] THEN [OS_1] <> [OS_2]`). Constraints can reference parameters only — never sub-models as units — and cannot do arithmetic.

**Sub-models** are the feature everyone reaches for when they hear "layered PICT," and they are the feature most likely to disappoint. Syntax is `{ P1, P2, P3 } @ N`, where `@N` locks a combinatorial order for that subset independent of the global `/o:N`. The PICT docs say it plainly: **"the model hierarchy can be just one level deep."** Sub-models cannot nest, cannot reference other sub-models, cannot be constrained as units, and cannot span files. They are a local density knob — useful for testing a hardware subset at triple-order while the rest stays pairwise — not a recursion primitive.

The one native composition mechanism is **seeding**. `pict model.txt /e:seed.tsv` takes a TSV identical in shape to PICT's own output (tab-separated, header row of parameter names, one case per row, empty cells allowed) and forces those rows into the generated suite when they do not violate constraints. This round-trips cleanly: `pict a.txt > a.tsv; pict b.txt /e:a.tsv` reuses the first run's coverage inside the second. Seeds exceed any native model-composition feature and are the one lever that actually enables "layered" PICT runs.

The remaining surface is thin but important. The CLI exposes `/o:N|max` (order; default pairwise), `/d:C` (value separator), `/a:C` (alias separator), `/n:C` (negative prefix), `/e:file` (seeds), `/r[:N]` (randomize with optional deterministic integer seed), `/c` (case-sensitive), and `/s` (stats to stderr). **Output is TSV to stdout — there is no JSON, CSV, or structured option.** Post-processing is mandatory for any non-trivial target. A C API (`api/pictapi.h`) exposes `PictCreateTask`, `PictAddParameter`, `PictAttachChildModel(parent, child, order)`, `PictAddExclusion`, `PictAddSeed`, and `PictGenerate`; it works on integer value indices, not strings, so the caller owns the value dictionary. A Windows DLL repackages the CLI for in-process invocation, and `pypict` wraps both for Python. There is **no official OpenAPI integration, no GUI, and no `include` directive**. The whole recursion story has to be built outside PICT.

## Three interpretations of "recursive PICT" against Petstore

The three approaches diverge on where the recursion lives: in wrapper scripts (a), inside one model file (b), or inside the LLM loop (c). Only (a) and (c) survive contact with PICT's actual limits.

### Approach A — wrapper-orchestrated hierarchy with TSV seeds

A tree of small `.pict` files mirrors the API tree. A **top-level model picks which endpoint to exercise**, a second-level model (one per endpoint) enumerates its parameter combinations, and a third-level model expands complex body objects. The wrapper runs them in dependency order and uses `/e:` seeds to propagate key combinations downward.

```pict
# L0_api.pict  — which endpoint × which auth × which content-type
Endpoint:     POST_pet, PUT_pet, GET_pet_findByStatus, GET_pet_byId,
              POST_pet_byId_form, DELETE_pet_byId, POST_pet_uploadImage,
              POST_store_order, GET_store_inventory,
              POST_user, GET_user_login, GET_user_byUsername
Auth:         none, api_key_valid, ~api_key_invalid, oauth_valid, ~oauth_expired
ContentType:  application_json, application_xml, ~form_urlencoded, ~multipart

IF [Endpoint] = "POST_pet_byId_form"     THEN [ContentType] = "~form_urlencoded";
IF [Endpoint] = "POST_pet_uploadImage"   THEN [ContentType] = "~multipart";
IF [Endpoint] IN {"GET_store_inventory","GET_pet_byId"}
                                         THEN [Auth] IN {"api_key_valid","~api_key_invalid"};
IF [Endpoint] LIKE "*pet*" AND [Endpoint] <> "GET_pet_byId"
                                         THEN [Auth] IN {"oauth_valid","~oauth_expired"};
```

```pict
# L1_pet_post.pict — body for POST /pet (run once per L0 row that picked POST_pet)
Name:          "doggie", "cat-42", "", ~"null", ~"<script>"
Status:        available, pending, sold, ~unknown
CategoryShape: none, id_only, name_only, id_and_name, ~malformed
TagsCount:     0, 1, 3, ~negative_id
PhotoUrls:     empty, one_valid, many_valid, ~bad_url_scheme

IF [Name] = ""                         THEN [Status] = "~unknown";
IF [CategoryShape] = "~malformed"      THEN [TagsCount] = "~negative_id";
{ Name, Status, CategoryShape } @ 3
```

```pict
# L2_pet_category.pict — expands CategoryShape = "id_and_name"
CatId:    1, 2, 999, ~-1, ~"abc"
CatName:  "Dogs", "Cats", "", ~"a"*300
```

The wrapper executes `pict L0_api.pict > l0.tsv`, iterates rows, and for each `Endpoint=POST_pet` row calls `pict L1_pet_post.pict /e:l0_pet_seed.tsv > l1.tsv`. Seeds from L0 (e.g., the chosen `Auth` and `ContentType`) are injected by writing a small TSV that names the matching parameters. Where L1 picks `CategoryShape=id_and_name`, the wrapper calls `pict L2_pet_category.pict` and splices the CatId/CatName row back into the L1 row's JSON assembly. The recursion tree is the API tree; PICT is invoked once per node.

**This is the approach that actually works at API scale.** It uses PICT for what PICT is good at (minimal covering arrays over each small space) and puts composition where composition has to live anyway (in code that understands OpenAPI `$ref`, `oneOf`, and nested bodies).

### Approach B — native sub-models and constraints in a single file

This is the interpretation that flatters PICT's native features and breaks first. You flatten the entire API — every endpoint, every parameter, every body field — into one model file and rely on sub-models and constraints to carve out per-endpoint layers:

```pict
# mega.pict — all of Petstore in one file
Endpoint:     POST_pet, PUT_pet, GET_findByStatus, GET_petById, DELETE_petById,
              POST_order, GET_inventory, POST_user, GET_login
HttpMethod:   GET, POST, PUT, DELETE
PathPetId:    1, 10, 9999, ~-1, ~abc, NA
QueryStatus:  available, pending, sold, ~unknown, NA
BodyName:     doggie, cat-42, "", ~null, NA
BodyStatus:   available, pending, sold, NA
OrderPetId:   1, 10, 9999, NA
OrderQty:     1, 10, ~-1, NA
UserName:     alice, bob, "", NA

IF [Endpoint] = "POST_pet"          THEN [HttpMethod] = "POST"   AND [PathPetId] = "NA"
                                    AND [QueryStatus] = "NA"    AND [BodyName] <> "NA";
IF [Endpoint] = "GET_findByStatus"  THEN [HttpMethod] = "GET"    AND [QueryStatus] <> "NA"
                                    AND [BodyName]    = "NA";
IF [Endpoint] = "GET_petById"       THEN [PathPetId] <> "NA"    AND [BodyName] = "NA";
# ...and so on for every endpoint...

{ Endpoint, HttpMethod }                    @ 2
{ BodyName, BodyStatus }                    @ 2
{ OrderPetId, OrderQty }                    @ 2
```

This is the **dummy-value pattern** — every parameter must be present in every row because PICT has no conditional-existence concept, so each parameter gets an `NA` sentinel and a forest of `IF Endpoint=... THEN OtherParam = "NA"` constraints forces irrelevant values off. It technically runs. It becomes unmaintainable at about ten endpoints. The parameter namespace collides (`Name` means three different things across pet/user/category), the constraint file grows quadratically, and because sub-models cannot nest you cannot express "exercise the body sub-model at order 3 only when `Endpoint=POST_pet`." The dummy-value rows also inflate every case count. **Use sub-models as a local density knob inside a single endpoint's L1 model, not as the recursion primitive.**

### Approach C — LLM-in-the-loop recursion

Here PICT is driven by a coordinating agent that reads a PICT row, decides based on its content that a deeper model is needed, **asks the LLM to emit the next `.pict` file on the fly**, runs PICT against it, and recurses. The L0 and L1 models look identical to approach A, but instead of pre-authoring L2 models for every complex nested type, the wrapper sees `CategoryShape=id_and_name` in an L1 row and prompts the LLM with the relevant OpenAPI schema fragment:

> Generate a PICT model file for the `Category` schema with id (int64), name (string, 1..50 chars). Include one invalid value per field prefixed with `~`. Output only the model file text.

The LLM responds with `L2_category.pict`, the wrapper runs it, splices the TSV row in. This trades authorship time for runtime LLM calls and non-determinism. **Use (c) selectively inside (a)** — lazily generate L2/L3 models for schemas the pre-authored tree does not cover, then cache them. Pure (c) is too slow and drift-prone for a POC; pure (a) is verbose but deterministic and git-diffable. The sweet spot is **(a) with (c) as the fallback for long-tail nested schemas**.

## Comparing the three approaches

| Axis | (A) Wrapper hierarchy + seeds | (B) Single file + sub-models | (C) LLM-in-the-loop |
|---|---|---|---|
| **Fidelity to API structure** | High — tree mirrors OpenAPI paths/schemas 1:1 | Low — flattening loses structure; dummy-value `NA` leaks into every parameter | High — LLM reads the schema directly |
| **Scalability** | Linear in endpoint count; each model stays small | Quadratic in constraints; collapses past ~10 endpoints | Linear, but rate-limited by LLM latency and cost |
| **LLM-friendliness** | Excellent — small targeted emissions per node | Poor — one giant file the LLM must keep coherent | Excellent by construction |
| **Maintainability** | Good — `.pict` files are small, diffable, reviewable | Poor — constraint forest grows with every endpoint | Fair — files are ephemeral; caching needed |
| **Determinism / CI reproducibility** | High with `/r:N` seeds pinned | High | Low without caching the generated files |
| **Drives TDD well** | Excellent — one test file per endpoint model | Mediocre — 1 giant parametrize table; poor failure locality | Good once cached; cold-start painful |

**Recommendation: approach A as the spine, approach C as the lazy filler for deep nested schemas.** Approach B is a trap dressed up as elegance.

## TDD output format — pick pytest, layer the rest

Five candidates were evaluated against the test the POC must pass: can a freshly-generated suite **fail correctly on day zero** when no Zato service exists, then turn green one endpoint at a time as the developer implements?

**Pytest + httpx with PICT rows as `@pytest.mark.parametrize` data wins.** The stack is Python — shared language with Zato means tests, services, and SQLite fixtures all read the same. LLMs emit pytest with very high reliability because the idiom is everywhere in their training data. Selecting a single failing combination is `pytest -k case-042`. Fixtures handle base URL, OAuth/api_key bootstrap, and per-test SQLite savepoint rollback. JUnit, Allure, and coverage integration are standard.

**Schemathesis layers in the same pytest file for free response-schema validation.** The codegen emits `@schema.parametrize()` alongside the PICT parametrize, and each case call becomes `case.call_and_validate()` — you stop hand-writing response assertions per endpoint and get 200-but-body-wrong bugs surfaced automatically. Schemathesis's stateful phase follows OpenAPI `links` and fills the workflow gap PICT's row-per-case model cannot.

**Hurl files are emitted as a secondary artifact** from the same PICT TSVs via a Jinja2 template. One request block per row, captures for `pet_id`, plain-text diffs that non-Python developers (the SmartClient front-end, ops smoke tests) can run with zero toolchain. Hurl adds negligible codegen cost and pays off in shareability.

**Hypothesis `RuleBasedStateMachine` covers ordered workflows** (create-pet → place-order → checkout → delete) where PICT's matrix cannot express ordering. Keep this to five to ten hand-authored machines — they are high value but expensive to author.

**Skip Dredd, Newman, and Zato-native in-process tests.** Dredd fires one example per operation and the project is in maintenance; Newman drags Node and verbose JSON collection files into a Python project; a Zato in-process harness fights red-first TDD because `Service` needs a live `ParallelServer` context and the service classes do not exist yet. Treat Zato as a black box behind its REST channel.

Net effect: **one `pytest` invocation runs PICT rows + schema validation + Hypothesis workflows**; a parallel `hurl --test tests/*.hurl` job provides a zero-Python smoke suite.

## End-to-end flow

```
┌─────────────────┐
│ petstore.yaml   │ OpenAPI 3.0 spec (Swagger Petstore v3)
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Spec analyzer (Python)                                         │
│  • Walks paths/schemas/security                                 │
│  • Emits equivalence classes per field (valid + ~invalid)       │
│  • Decides which endpoints need L1/L2/L3 models                 │
└────────┬────────────────────────────────────────────────────────┘
         │
         ▼                             ┌──────────────────┐
┌──────────────────────┐        cache  │ LLM (approach C  │
│ Pre-authored L0/L1   │◄──────────────┤ fallback for     │
│ .pict files in git   │    miss ──►   │ unknown schemas) │
└────────┬─────────────┘               └──────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  PICT orchestrator                                           │
│  L0: pict L0_api.pict /r:42 > l0.tsv                         │
│  for row in l0.tsv:                                          │
│      build per-row seed slice                                │
│      pict L1_<endpoint>.pict /e:seed.tsv /r:42 > l1.tsv      │
│      for row in l1.tsv with complex body:                    │
│          pict L2_<schema>.pict /e:... > l2.tsv               │
│  Assemble rows into structured HTTP requests (JSON bodies)   │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  TDD codegen                                                 │
│  • tests/test_<operation>.py (pytest + httpx + Schemathesis) │
│  • tests/workflows/*.py       (Hypothesis state machines)    │
│  • tests/smoke/*.hurl         (Hurl, generated same rows)    │
└────────┬─────────────────────────────────────────────────────┘
         │ pytest -x  (all red on day zero)
         ▼
┌──────────────────────────────────────────────────────────────┐
│  LLM build driver (system prompt §below)                     │
│  Consumes: OpenAPI + recursive PICT model tree               │
│          + target-architecture exemplars                     │
│          + failing test names                                │
│  Emits:                                                      │
│  • schema.sql                (SQLite DDL)                    │
│  • zato/services/*.py        (Service classes, SIO, SQL)     │
│  • zato/enmasse.yaml         (REST channels, outconn_sql)    │
│  • smartclient/ds/*.ds.xml   (DataSources)                   │
│  • smartclient/ui/*.js       (ListGrid + DynamicForm)        │
└────────┬─────────────────────────────────────────────────────┘
         │ zato hot-deploy; restart; pytest -x
         ▼
  Red → green, one endpoint at a time, until suite passes.
```

The orchestrator and codegen are both pure Python (~300 lines each); the LLM appears twice — once optionally for approach-C PICT generation, once for the build. **No step except the final LLM build emits more than templated text; everything else is deterministic.**

## LLM system prompt for the build driver

The prompt must be narrow (it is generating production-shape code) and must reference canonical exemplars for every artifact type. Embed the following skeleton and fill the bracketed slots per run:

```
You are a code generator for a Zato ESB + SQLite + Isomorphic SmartClient stack.
You will receive:

  1. An OpenAPI 3.0 spec fragment for ONE operation (method + path).
  2. The PICT model files (L0, L1, L2) that cover this operation.
  3. The generated failing pytest file for this operation (so you know the
     exact contract the code must satisfy).
  4. A SQLite DDL fragment for any tables this operation touches.
  5. Exemplar files:
       - zato_service_exemplar.py     (canonical Service class with dataclass
                                       Model SIO, SQLAlchemy session pattern,
                                       error handling, correlation id logging)
       - zato_enmasse_exemplar.yaml   (channel + outconn_sql stanza shape)
       - smartclient_ds_exemplar.xml  (RestDataSource with transformRequest/
                                       transformResponse adapted to Petstore's
                                       bare-JSON wire format)
       - smartclient_ui_exemplar.js   (ListGrid + DynamicForm bound to DS)

Your job is to emit, in a single response, the files that make the pytest
file for this operation pass:

  - zato/services/<module>.py        (add or update Service class)
  - zato/enmasse.yaml                (add REST channel for this operation)
  - smartclient/ds/<Entity>.ds.xml   (add or update DataSource fields /
                                      operationBindings for this operation)
  - schema_migrations/NNN_<op>.sql   (idempotent DDL if schema changes)
  - (optional) smartclient/ui/<Entity>Pane.js if this is the first CRUD op
                                              for the entity

Rules:
  - Never invent fields not present in the OpenAPI schema.
  - Use the dataclass-Model SIO form (Zato 4.x), not the tuple form.
  - All SQL uses named parameters, never string formatting.
  - Status enums become SQLite CHECK constraints matching the OpenAPI enum.
  - For SmartClient, put the Petstore-envelope adaptation in
    transformResponse; do not require server-side wrapping unless the test
    file explicitly imports the adapter service.
  - If the PICT model includes `~` negative values, the service must return
    the exact HTTP status code asserted in the pytest file (400 / 404 / 405).
  - Response payloads must round-trip through `zato apispec` cleanly, i.e.
    dataclass Model fields match the OpenAPI response schema names exactly.
  - Do not emit prose, comments, or explanations. Output only file blocks
    in the form:
      === FILE: <relative path> ===
      <file contents>
      === END FILE ===

If the OpenAPI operation depends on state from another operation (e.g.
GET /pet/{petId} after POST /pet), assume the test fixture seeds the DB
and generate the read path only.
```

The **exemplars are non-negotiable** — without them the LLM drifts between Zato 3.x tuple SIO and 4.x dataclass SIO, and invents SmartClient DataSource properties. A four-file exemplar pack is enough to pin the dialect.

## Phased implementation plan

**Week 1 — spine.** Build the spec analyzer and the PICT orchestrator against one endpoint: `GET /pet/findByStatus`. Hand-author `L0_api.pict` (with this one endpoint) and `L1_findByStatus.pict`. Emit a pytest file with ~15 parametrized rows including three `~`-prefixed negatives. Stand up an empty Zato instance with one placeholder service and confirm all 15 tests go red with 404. Implement the service + SQLite table + enmasse channel by hand. Turn all 15 green. **Milestone: one endpoint round-trips red-to-green without the LLM in the loop.** This proves the wiring.

**Week 2 — fan out and codegen.** Add `POST /pet`, `GET /pet/{petId}`, `DELETE /pet/{petId}`, `POST /store/order`. Introduce L2 models for the Pet body's `category` and `tags`. Introduce the LLM build driver with the four exemplar files. Feed it one failing test file at a time; measure first-pass success rate (target ≥70% of generated services pass the test unmodified). Add Schemathesis integration to the pytest suite. **Milestone: five endpoints green; LLM emits Zato services directly from PICT output; Schemathesis catches at least one schema-violation bug the hand-written assertions missed.** Also emit Hurl files in parallel and confirm they run green against the Zato instance.

**Week 3 — UI, workflows, hardening.** Generate SmartClient DataSources for Pet, Order, User. Add a ListGrid + DynamicForm for Pet via the LLM using `smartclient_ui_exemplar.js`. Decide adapter strategy (recommendation: **put a thin Zato adapter service in front** that wraps responses in the RestDataSource envelope — cleaner than `transformResponse` and the adapter is itself PICT-testable). Author three Hypothesis `RuleBasedStateMachine` workflows (pet lifecycle, order lifecycle, user login/logout). Pin `/r:N` seeds everywhere for CI reproducibility. Run the full suite; fix drift. **Milestone: full Petstore v3 (≈18 operations) green end-to-end, SmartClient UI exercises Pet CRUD in a browser, CI is deterministic.**

**Week 4 (stretch) — recursion under stress.** Swap the Petstore spec for a mutated version (add a new optional field to `Pet`, add a new endpoint, deprecate one). Measure how much of the pipeline re-runs cleanly without human edits. This is the real test of the hypothesis: **can the tool chain absorb spec evolution?** Document what broke and what the LLM regenerated correctly.

## Risks and open questions

**PICT does not compose recursively natively** — confirmed. The POC must own a wrapper script that orchestrates PICT invocations and splices TSV rows into structured JSON. This is ~300 lines of Python and the largest unknown unknown is how it handles `oneOf`/`anyOf`/discriminator polymorphism in more realistic specs than Petstore. Mitigation: use approach C (LLM) as the escape hatch for schemas the deterministic translator cannot map.

**LLM state across recursive invocations.** The build-driver LLM sees one operation at a time but must generate services that share a `models.py` file and a single `enmasse.yaml`. Two defenses: (1) pass the current state of those shared files in every prompt and require the LLM to emit diffs or full replacements; (2) run a deterministic post-merge step that deduplicates dataclass definitions and merges YAML. Expect the LLM to re-invent `Category` three times if you do not handle this.

**Auth is stateful and not fully captured by PICT rows.** The `/user/login` → bearer-token → `/pet` flow is a workflow, not a combination. Mitigation: pytest fixture owns login once per session and injects the token; PICT models include an `Auth` parameter at L0 purely to drive negative (`~expired_token`) cases, not to enumerate login-per-request.

**Petstore's public server is stateful and shared** (world-writable, tests interfere). Do not run the suite against the public instance; point at your own Zato instance from test one. This is also why pytest fixtures must roll back SQLite between tests.

**Weights are hints, not quotas.** If the POC needs "happy path runs 10× more often than negative path" for stress testing, PICT will not deliver it reliably. Use Hypothesis `@settings(max_examples=N)` with weighted `st.one_of` for distributional control.

**Case-sensitivity.** PICT parameter names are case-insensitive by default. OpenAPI operationIds like `getPetById` vs schemas like `Pet` can collide. Use `/c` or uppercase-prefix all PICT parameter names.

**Sub-models' one-level-deep limit means approach B is not a fallback.** If the wrapper orchestrator proves harder than expected, the instinct will be to "just put it all in one PICT file." Resist. The constraint forest is quadratic and will not scale past the pet/store split.

**Schemathesis may generate cases that contradict PICT rows.** When the two tools disagree about what a valid payload looks like, prefer Schemathesis's OpenAPI-grounded view and treat PICT rows as a subset. Configure Schemathesis to skip examples PICT already covers to avoid double-counting.

**Zato has no first-class OpenAPI importer.** The LLM does the spec-to-service mapping; `zato apispec` only does the reverse (services to OpenAPI). If the generated services drift from the spec, `zato apispec` output can be diffed against the source `petstore.yaml` as a CI gate — a cheap drift detector worth adding in week 3.

## Complementary tools worth keeping in reach

**Hypothesis + `hypothesis-jsonschema`** replaces PICT entirely if you are willing to trade minimal covering arrays for random-plus-shrinking. Use it for shrinking (PICT has none) and for stateful workflows. Do not use it alone — its random search misses the pairwise-interaction guarantee PICT provides for cheap.

**Schemathesis** — already in the recommended stack, mentioned here for completeness: its stateful mode chains operations via OpenAPI `links`, which Petstore does not declare but you can add in a patched spec. This is a low-cost way to auto-derive the pet-lifecycle workflow that Hypothesis would otherwise hand-author.

**Tavern** (YAML-driven pytest plugin) sits between Hurl and pytest. Consider it if the SmartClient team wants YAML they can read but you want pytest reporting. Probably redundant given Hurl + pytest already covers both constituencies.

**Pact / Pactflow** for consumer-driven contract tests. Out of scope for a POC, but if the SmartClient UI and Zato backend evolve independently post-POC, Pact contracts generated from the same PICT rows would catch drift earlier than Schemathesis.

**APIFuzzer, RESTler (Microsoft), EvoMaster** for security/fuzz coverage. PICT's `~`-negative matrix is a strong baseline but does not know about injection payloads or grammar-aware fuzzing. RESTler in particular is a natural peer to PICT — also from Microsoft, also OpenAPI-driven, but stateful-fuzz-oriented. Running RESTler weekly in CI alongside the PICT-driven pytest suite would be the obvious post-POC addition.

**pypict** for embedding PICT inside the Python orchestrator instead of shelling out. Faster and removes the `pict.exe` dependency at the cost of a native build step. Optional optimization for weeks 3+.

## Conclusion

The hypothesis is viable but reframes itself once grounded. **PICT is a combinatorial engine, not a recursion engine**; the recursion lives in a Python wrapper that mirrors the OpenAPI tree, calls PICT once per node, and uses `/e:` TSV seeding for the only native cross-invocation composition PICT actually supports. The LLM appears twice — optionally as an emitter of long-tail per-schema PICT files, mandatorily as the driver of Zato service, SQLite DDL, and SmartClient DataSource generation — and is kept on rails by four exemplar files pinning the dialect. The TDD output is pytest + httpx parametrized on PICT rows, with Schemathesis overlaying response-schema validation, Hurl mirroring the same rows as a zero-Python smoke suite, and Hypothesis `RuleBasedStateMachine`s covering the five or so workflows PICT's matrix cannot express. The single biggest design lesson from reviewing the PICT docs is that **approach B — one big file, sub-models as layers — is a dead end** because sub-models are explicitly one level deep; any architect who has not read `doc/pict.md` will reach for it first and waste a week. Start with approach A, reserve approach C as the escape hatch, keep the first end-to-end loop narrow (one endpoint, no LLM) so week one delivers a proven wiring, then fan out. Measured against the week-four stretch goal — can the pipeline absorb spec evolution without human edits — this architecture has a realistic shot, and its failure modes are ones you can see coming from the PICT documentation itself.