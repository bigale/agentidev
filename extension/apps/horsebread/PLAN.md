# Horsebread Plugin (stub)

This directory is reserved for the **horsebread** domain plugin — an FTC Innovations horse racing evaluation pipeline that will be assembled here at build time from its own private repo.

**Status**: planned, not yet implemented. Depends on `plans/host-capability-interface.md` Phase 0–3 being complete first.

---

## Where the plan lives

The full horsebread-specific plan (pipeline orchestration, acquire/compute boundary, plugin manifest, rootfs spec, phase breakdown) lives in the **private horsebread repo**:

```
/home/bigale/repos/horsebread/plans/horsebread-agentidev-plugin.md
```

It stays private because it contains domain-specific content (Betmix scraping details, DB schema, Python dep lists) that doesn't belong in the public platform repo.

## Target architecture

Per `plans/host-capability-interface.md` in this repo — horsebread consumes the `HostCapabilities` interface and is assembled into this directory at build time via a script in the horsebread repo (`scripts/assemble.sh`). No horsebread code is committed to agentidev.

### High-level shape (public-safe summary)

- **Mode**: `?mode=horsebread` on the existing SmartClient wrapper
- **Runtime**: CheerpX sandbox iframe (x86 Linux VM), mounts the horsebread repo from OPFS
- **Compute**: Python + Node pipelines run unmodified inside the VM
- **Acquire**: live scraping stays on the agentidev bridge server; in-VM scripts reach out via a shimmed `fetch()` → `host.network.fetch` → service worker → existing bridge client → real Playwright
- **UI**: SmartClient dashboard template with pipeline buttons, run history grid, Monaco source viewer, live console HTMLFlow, and an HTML card preview pane

### Build assembly (summary)

From the horsebread repo:

```bash
AGENTIDEV=/home/bigale/repos/agentidev ./scripts/assemble.sh
```

Copies `horsebread/agentidev-plugin/` into `agentidev/extension/apps/horsebread/`, and builds a `horsebread-repo.tar.gz` into `agentidev/packages/bridge/assets/horsebread/` for the CheerpX rootfs mount.

## Gitignore

Once the plugin architecture (platform Phase 2) lands, `extension/apps/horsebread/*` (except this `PLAN.md`) should be gitignored so assembled sources stay out of public git history. The gitignore rule and the assembly script come together.

Until then: do not commit any horsebread source files to this directory by hand.

## References

- Public platform plan: `plans/host-capability-interface.md`
- Private domain plan: `/home/bigale/repos/horsebread/plans/horsebread-agentidev-plugin.md`
- Horsebread repo: `/home/bigale/repos/horsebread/` (private)
- Sibling plugin placeholder: `extension/apps/ado-extension/PLAN.md`
